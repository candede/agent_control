# Official usage import

This runbook imports the Microsoft 365 admin-center Copilot Agents usage exports. These files are the only official per-agent and per-user usage authority in Agent Control. Do not substitute audit, Defender, telemetry, transcripts, package events or Microsoft 365 Copilot app-adoption Graph reports.

## Export the three files

1. Sign in to the Microsoft 365 admin center with access to usage reports.
2. Open **Reports** (use **Show all** if Reports is hidden), then **Usage**. Under **Reports**, select **Microsoft Copilot > Agents**.
3. Select one documented reporting window: 7 days or 30 days.
4. Select each **Agents**, **Users & agents**, and **Users** table/tab and use its **Export CSV** action for that same period.
5. Keep the original files until Agent Control confirms that the complete bundle is active.

Microsoft says interaction usage can become visible within one hour. That is source latency, not proof that an exported or imported set is current. You do not need to record or enter dates to import the files.

Microsoft source: [Copilot Agents usage report](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide), rechecked 2026-09-09; source page updated 2026-08-18.

## Supported schemas

Header matching is case/whitespace normalized but otherwise exact. These labels are both current Microsoft documentation and fixture-observed export evidence:

| Export | Schema | Required headers |
| --- | --- | --- |
| Agents | `m365-agents-observed-v1` | Agent ID; Agent name; Creator type; Active users (licensed); Active users (unlicensed); Responses sent to users; Last activity date (UTC) |
| Users & agents | `m365-users-agents-observed-v1` | Agent ID; Agent name; Creator type; Username; Responses sent to users; Last activity date (UTC) |
| Users | `m365-users-observed-v1` | Username; Display name; Number of agents used; Agent responses received; Last activity date (UTC) |

The CSVs do not contain reporting-period or source-as-of metadata columns. Agent Control imports **all rows**, derives the minimum and maximum available UTC last-activity dates, and labels that coverage `activity_range`. This is observed activity coverage, **not** the actual reporting window or proof of complete daily coverage. Different files may have different activity ranges; that does not make the bundle incompatible. Reports without dated activity remain importable with unknown coverage.

The source refresh time remains unknown. The app does not guess it from the filename, upload time, or last-activity date. Previously imported administrator-supplied periods remain labeled `operator_asserted`; API clients can still supply explicit metadata, but the import screen does not ask for it. Export all three files from the same Microsoft reporting selection: without period metadata, automatic import cannot prove that unrelated exports belong to the same reporting window.

Microsoft documents the following interpretation constraints:

- **Active users (licensed)** and **Active users (unlicensed)** are independent source categories. A license change can place one person in both categories during the selected period, so even one agent's distinct total can be less than their sum. Agent Control never adds them. Per-agent distinct active users come from exact Users & agents identities; without that bridge the value is `Unknown`.
- Response values from Agents, Users & agents, and Users remain separate source totals. The headline response total uses Agents only and excludes bridge-only agents instead of creating a hybrid total.
- In Users & agents, **Last activity date (UTC)** is when that agent was last used by anyone. It is preserved with that exact meaning and is not used as the named user's recency. User recency comes from the Users export and is `Unknown` when no Users row exists.
- Usernames can be anonymized according to Microsoft 365 report settings. They remain case-sensitive dataset-scoped identifiers and are never guessed back to people.

## Initial setup and cumulative history

First-use data sync includes a manual official-usage step. After initialization of an empty database, the step asks for the three companion Microsoft exports again; an empty report table is not treated as completed setup. An Admin must validate and accept a complete bundle. Other source collection and saved-data browsing can continue while upload or permissions are pending.

Ordinary later uploads add to retained history rather than requiring a correction of the previous report. Exact repeated content is deduplicated; unchanged row payloads can be reused across imports while their source associations and metadata remain available. Changed counts, names, or activity values remain distinct observations. Content reuse does not prove that two anonymized users in different reports are the same person.

This preserves historical observations beyond Microsoft's rolling 7/30-day export window. It does not turn aggregate CSVs into event logs: adjacent exports overlap, and neither adding their response totals nor subtracting one snapshot from another establishes exact daily activity. Last-activity ranges do not establish report-window boundaries. Historical report views keep the original source metrics and lineage rather than presenting an invented all-time usage total.

Full resync preserves accepted report history, including the Sync tab's explicitly confirmed **Clear saved data and resync** option. That option clears the current account's saved users and inventory, not official reports. Deleting official reports remains a separate, explicitly confirmed Admin operation; it is not part of re-running setup. Opening the report uploader from Sync leaves the page and its server-owned jobs in place; closing the uploader returns to the sync page.

## Validate and accept

1. Sign in with `AgentControl.Admin`. Admin includes all Viewer access, including aggregate and user-level accepted report views.
2. Use the usage-upload step in initial setup or open **Official usage > Import reports**. Expand **How to export the CSV files** for Microsoft export instructions. No reporting start, reporting end, or source-as-of input is required. An ordinary new export is an addition to history, not a correction; use explicit correction only for an intentionally superseding report.
3. Choose one or more original CSVs and select **Validate and stage**. The server, not the browser, identifies each kind and parses the rows.
4. Review the full bundle hash, coverage, per-file hash/schema/period/source basis, warnings and reconciliation. Source values that disagree remain separate and visible.
5. Add missing companions to the same bundle. Reloading restores the current Admin's active staging. Incomplete submissions remain non-published and cannot change active usage.
6. Select **Accept reviewed bundle** only when all three kinds are present. The server rechecks the bundle hash and active-selection revision and commits all staged companions atomically. Select **Back to reports** to see the refreshed dashboard.

Closing the dialog does not accept or discard reports. Reopening it on the same page preserves selected files and validation results. After navigating away or reloading, reopen **Import reports** to restore server-side staging; files not yet staged must be selected again. Exact staging links open the dialog automatically. Retained-set selection and deletion remain inside this management experience, with a separate confirmation.

If a file fails validation, its actual error and filename remain visible. Successful companion files remain staged; rejected files can be retried without restarting the bundle. An entirely rejected upload does not trigger a lookup for a nonexistent bundle.

Exact retries use a finite content-free receipt containing tenant, actor, bundle, original hash/revision and original result. They return that result after staging cleanup without replaying or reselecting anything; changed intent fails. A correction creates a superseding set. Selecting or deleting a retained set requires a separate native confirmation dialog. Deleting the active set clears selection; Agent Control never chooses an older set automatically.

## Read the dashboard and review licenses

The dashboard starts with response, distinct-user, and agent totals for the selected report snapshot followed by usage charts, not import controls. Activity coverage and availability remain visible. **Report details** expands source authority, freshness, versions, reconciliation, and interpretation limits; a compact **Source totals differ** indicator remains visible when totals disagree. Retained report history is readable by Viewers and Admins; import approval, corrections, active-set selection and deletion remain Admin operations.

A snapshot dashboard includes all its rows, including undated and zero-response rows; the accumulated history preserves previous snapshots separately. Optional date filters are applied **after import** to the last-activity values. The CSVs are aggregate snapshots, not daily activity logs: filtering a row by its last-activity date does not turn its full-export response count into a count for the selected interval.

| Source | Information available for analysis |
| --- | --- |
| Agents | Every agent ID, name, creator type, licensed and unlicensed active-user category, response total, and agent-wide last-activity date |
| Users | Every reported username, display name, agent count, responses received, and the user's last-activity date |
| Users & agents | Each reported user-agent relationship, agent ID/name/creator, response count, and the agent-wide last-activity date |

Response totals and agent counts from the Users export are shown separately from the user-agent relationship totals when they disagree. A source discrepancy is a data-quality signal, not a reason to discard rows or overwrite one report with another. Identifiers seen in only one report remain available with their missing-source status.

Filtered agent and user CSV downloads preserve these source distinctions. The user download has one row per reported user-agent relationship, or one row with empty agent fields when the user has no relationship rows. User-level totals repeat on relationship rows; do not sum those repeated totals as though they were per-agent counts.

For IT license reviews:

1. Sort users by responses to see the most and least active reported users. Use a configurable low-response threshold to assemble a review cohort, and inspect each user's agent breakdown and creator types.
2. Review zero-response, low-response, and stale-activity signals separately. A blank last-activity date means unknown, not inactive. User recency must come from Users, never from the agent-wide date on a Users & agents row.
3. Inspect discrepancies before acting and retain the source totals in exported review data.
4. Confirm the person's current Microsoft 365 Copilot license assignment, broader Copilot activity, role, and business need using your approved administration workflow before reclaiming or reallocating a license.

**These exports cannot identify every unused Microsoft 365 Copilot license.** They do not include a tenant license roster, per-person license assignment, or all Copilot use in Word, Excel, Teams, Outlook, and other apps. A user absent from the files cannot be classified as having zero usage. Even a reported user with zero agent responses may use Copilot elsewhere. License status is therefore unavailable at user level; low agent usage is a candidate for review, not an automatic unassignment recommendation. Licensed and unlicensed agent-level categories cannot be joined back to individual users.

## Export compatibility check

The three supplied September 12, 2026 exports were checked against the header registry: all 7 Agents columns, 6 Users & agents columns, and 5 Users columns match. UTF-8 BOMs, quoted English UTC dates, and quoted comma-grouped counts are supported. No additional CSV columns are silently ignored.

The supplied snapshot contains 244 agents, 517 user-agent relationships, and 300 users, with observed UTC last activity from August 14 through September 12. Agents and Users & agents each report 9,693 responses; Users reports 9,697. One user's source totals differ. There are 145 reported users with 1-5 responses and no zero-response rows in this Users export. This does **not** establish that the tenant has no inactive license holders.

## Limits and retention

Existing installations must apply schema migrations through 31 using the normal [deployment workflow](deployment-setup.md) before starting the updated runtime. Migration 29 backfills deduplicated report payloads and semantic content identities while preserving existing lineage; migration 30 adds private source-sync and saved user data; migration 31 adds explicitly admitted, principal-scoped clean resync while preserving accepted usage reports. Earlier migrations and their checksums are unchanged. Use the migration operator, not the restricted runtime database role. No in-app full resync applies migrations or wipes the database.

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

Run ordinary [operator retention](operations.md#retention) at least daily while the POC is active. Load the existing internal helper and use its exact project/database confirmation, preview and bounded-batch safeguards as documented there. Retention is not a `deploy-local.ps1` argument.

`OFFICIAL_USAGE_STALE_AFTER_DAYS` defaults to 35 and accepts 1 through 365. Staleness uses the age of the available coverage endpoint and the accepted-set age; an absent activity date is not evidence of a fresh source. Never treat `unknown` source freshness as current.

## Failure recovery

- A malformed, incompatible or schema-drift file is rejected without changing the active set. Correct the input and stage that kind again in the same bundle.
- A missing companion leaves the bundle incomplete and acceptance disabled. Reload or use **Resume** on the retained incomplete set.
- A stale bundle hash or active revision returns a conflict. Refresh import state and review the complete current bundle again.
- A partial discard failure remains visible. Refresh and retry only the staged rows still owned by the current Admin.
- Expired staging cannot be accepted. Re-export when freshness matters and stage the original files again.
- Upload timeout/disconnect cancels publication at the transaction boundary. If cleanup cannot be verified, the API returns `upload_cleanup_failed` when possible and emits only the value-free `official_usage_upload_cleanup_failed` operational event; inspect owned staging before retrying.
- If the legacy browser notice appears, its value was not read or migrated. Re-import the original files and acknowledge removal, or explicitly acknowledge discard. Only the exact legacy key is removed; unrelated browser storage remains.

## API availability review

The current Microsoft Graph [`copilotReportRoot`](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/resources/copilotreportroot) lists exactly three `v1.0`/`beta` methods: `getMicrosoft365CopilotUserCountSummary`, `getMicrosoft365CopilotUserCountTrend`, and `getMicrosoft365CopilotUsageUserDetail`. They cover licensed Microsoft 365 Copilot app adoption/activity, not the Copilot Agents report's per-agent rows, user-agent bridge, licensed/unlicensed active-user categories and responses. The import feature does not call those methods. The separate [license usage dashboard](copilot-license-usage.md) requests `Reports.Read.All` and calls only the per-user D30 detail report on explicit snapshot load; it does not substitute that app activity for Copilot Agents metrics.