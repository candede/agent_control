# Official usage import

This runbook imports the Microsoft 365 admin-center Copilot Agents usage exports. These files are the only official per-agent and per-user usage authority in Agent Control. Do not substitute audit, Defender, telemetry, transcripts, package events or Microsoft 365 Copilot app-adoption Graph reports.

## Export the three files

1. Sign in to the Microsoft 365 admin center with access to usage reports.
2. Open **Reports** (use **Show all** if Reports is hidden), then **Usage**. Under **Reports**, select **Microsoft Copilot > Agents**.
3. Select one documented reporting window: 7 days or 30 days.
4. Select each **Agents**, **Users & agents**, and **Users** table/tab and use its **Export CSV** action for that same period.
5. Keep the original files until Agent Control confirms that the complete bundle is active.

Microsoft says interaction usage can become visible within one hour. That is source latency, not proof that an exported or imported set is current. You do not need to record or enter dates to import the files.

Microsoft source: [Copilot Agents usage report](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide), rechecked 2026-09-19; source page updated 2026-09-09.

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

- **Active users (licensed)** and **Active users (unlicensed)** are independent source categories. A license change can place one person in both categories during the selected period, so even one agent's distinct total can be less than their sum. Agent Control never adds them. Microsoft defines an active user as one who asks an agent a question and receives a response. Per-agent distinct active users come from exact, positive-response Users & agents identities; without companion rows for that agent the value is `Unknown`. Explicit zero-response rows remain reported relationships, but contribute zero active users. Tenant active-user totals deduplicate positive-response identities from Users and Users & agents without adding the two source counts.
- The drilldown's **Users with responses** metric follows the same per-agent evidence rule. It remains `Unknown` when the companion report is empty or contains only other agents, even though its reported relationship count is zero.
- Response values from Agents, Users & agents, and Users remain separate source totals. The headline response total uses Agents only and excludes bridge-only agents instead of creating a hybrid total.
- Computed report totals must fit the exact safe-integer range. If a total exceeds that range, the report returns an explicit `official_usage_total_limit` conflict rather than publishing a rounded number.
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

### Explore adoption from Agents and Users

- **Agents > Explore usage & users** searches reported agents and opens an exact report's response and user breakdown on the tenant-level Agents page. A report identity does not establish an inventory association or grant access-control targets.
- Inventory agent modals are strictly agent-scoped. Their Overview and **Usage & users** tabs never substitute tenant totals or unrelated report comparisons. Inventory usage requires an explicit Admin-reviewed association to an exact report identity in the active set (see below); without one, metrics remain unknown rather than matching a name or ID or claiming zero activity.
- **Users > User-agent matrix** shows response counts for each reported user-agent relationship, including concealed or unlinked identities. Select an agent column to focus that exact report ID. User paging and agent-column paging are explicit; columns describe the displayed user page, not all agents in the tenant.
- An explicit zero is reported evidence. **Not reported** is an absent relationship and says nothing about access or activity. **All-agent responses** is the independent Users-report total, not a sum of the visible matrix columns.
- Drilldown links carry the report snapshot so changing the tenant's selected report cannot silently change their meaning. **Use current reports** is an explicit switch. Current license details require an existing unique directory identity link for the same report set and versions, not a name or username heuristic. Historical or unmatched rows retain unknown license status.
- Saved report reads are bounded and do not call inventory providers: `GET /api/official-usage/agents/:agentId` accepts `setId`, user `search`, `sortBy`, `sortDirection`, `limit`, and `offset`. `GET /api/official-usage/users` accepts an optional exact, case-sensitive `agentId` filter before paging. User-level totals remain all-agent totals even under that filter. Viewer and Admin use the existing report-read authorization.
- Report detail, users, aggregate, history, and CSV queries reject unsupported, repeated, or structured parameters before reading saved data. A report selection is one exact `setId`, never the first value of an ambiguous query.

Filtered agent and user CSV downloads preserve these source distinctions. The user download has one row per reported user-agent relationship, or one row with empty agent fields when the user has no relationship rows. User-level totals repeat on relationship rows; do not sum those repeated totals as though they were per-agent counts.

### Review inventory usage associations

Microsoft describes the reported Agent ID as an app identifier generated by Microsoft, but does not document equivalence to a Graph package ID, Entra application ID, manifest ID, or Power Platform native ID. Equal strings and names are **not** identity evidence. Report-only browsing remains independent of inventory; no import creates associations automatically.

An Admin can explicitly browse candidates for an authorized saved agent and confirm a reporting-only association:

| Route | Contract |
| --- | --- |
| `GET /api/agent-inventory/:recordId/usage-candidates` | Admin only; explicit candidate browsing, optional `search` (256 characters), `offset` (0–100,000), `limit` (1–250, default 50). Returns only Agents-export rows, an `associated` flag, and active report context. No user rows or provider calls. |
| `POST /api/agent-inventory/:recordId/usage-associations` | Admin and CSRF; exact `reportSetId`, case-sensitive `reportAgentId`, source-qualified `target`, `expectedInventoryRevision`, `expectedUsageRevision`, and literal `confirmed: true`. |
| `DELETE /api/agent-inventory/:recordId/usage-associations` | Admin and CSRF; the same confirmed revision/set/report identity fields, without `target`. Only an association resolving to this currently authorized agent can be removed. |

Graph targets are `{ source: "graph_packages", packageId }`; Power Platform targets are `{ source: "power_platform", nativeId, environmentId }`, with an explicit `null` for an absent environment. A canonical UUID is a navigation reference, **not** an association target. Unknown fields and malformed identifiers, revisions, confirmation values, or paging are rejected. Successful mutations return `{ context }` only after commit; refresh the inventory before another review.

Associations are shared within a tenant but bind to **one immutable report set and one exact native source**, never to the reviewer's private canonical UUID. Another viewer sees metrics only when that same native source is present in their current authorized saved inventory. Package IDs and opaque native IDs are case-sensitive; Power Platform GUIDs and environments follow the existing inventory identity normalization. Each report ID has one target per tenant/set; reassignment requires explicit removal first. Multiple distinct report identities may attach to one logical inventory agent. A new active report set does not inherit old associations, even when its IDs, names, or underlying row content match.

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
4. Confirm the person's current Microsoft 365 Copilot license assignment, broader Copilot activity, role, and business need using your approved administration workflow before reclaiming or reallocating a license.

**These exports cannot identify every unused Microsoft 365 Copilot license.** They do not include a tenant license roster, per-person license assignment, or all Copilot use in Word, Excel, Teams, Outlook, and other apps. A user absent from the files cannot be classified as having zero usage. Even a reported user with zero agent responses may use Copilot elsewhere. The exports alone cannot establish a user's license status; the Users view adds separately saved directory context only through a verified user link. Low agent usage is a candidate for review, not an automatic unassignment recommendation. Licensed and unlicensed agent-level categories cannot be joined back to individual users.

## Export compatibility check

The three supplied September 12, 2026 exports were checked against the header registry: all 7 Agents columns, 6 Users & agents columns, and 5 Users columns match. UTF-8 BOMs, quoted English UTC dates, and quoted comma-grouped counts are supported. No additional CSV columns are silently ignored.

The supplied snapshot contains 244 agents, 517 user-agent relationships, and 300 users, with observed UTC last activity from August 14 through September 12. Agents and Users & agents each report 9,693 responses; Users reports 9,697. One user's source totals differ. There are 145 reported users with 1-5 responses and no zero-response rows in this Users export. This does **not** establish that the tenant has no inactive license holders.

## Limits and retention

Existing installations must apply schema migrations through 34 using the normal [deployment workflow](deployment-setup.md) before starting the updated runtime. Migration 29 backfills deduplicated report payloads and semantic content identities while preserving existing lineage; migration 30 adds private source-sync and saved user data; migration 31 adds explicitly admitted, principal-scoped clean resync while preserving accepted usage reports; migrations 32–33 add the canonical registry and saved-inventory verification; migration 34 adds reviewed reporting-only agent usage associations and audit actions. Earlier migrations and their checksums are unchanged. Use the migration operator, not the restricted runtime database role. Runtime grants permit association insert/delete, not reassignment updates or revision-counter writes; readiness verifies that boundary. No in-app full resync applies migrations or wipes the database.

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