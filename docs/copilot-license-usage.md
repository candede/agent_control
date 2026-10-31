# Microsoft 365 Copilot licenses and usage

> **Current implementation:** source collection, saved report composition,
> APIs, UI and exports use the record-backed contracts documented in
> [Saved-data architecture](data-architecture.md#official-reports-and-user-evidence).
> Saved reads do not issue background provider requests.

`GET /api/copilot-usage/users` is a read-only view for every Viewer-capable role of saved tenant-owned **Microsoft 365 Copilot entitlement evidence** and app activity, independent of the reader's provider permissions or personal collection history. Its `value` array contains one actor-bound selection page, with `page`, `counts`, `summary`, `sources` and `reports` metadata. The saved directory retains the full product-filtered discovery cohort plus exactly verified active report identities, including users with inactive or unverified paid features; these are not all Copilot-licensed users. The paid-user dashboard requests `cohort=licensed`, and licensed-user labels and adoption counts require verified active paid features. User rows contain scalar `copilotServiceState`, `servicePlanCount` and `entitlement` evidence; complete service plans are independently paged through `/api/copilot-usage/users/:objectId/service-plans` under the same selection. The API joins these saved sources to the selected imported official Copilot Agents usage set without calling Microsoft Graph. Automatic first-run and explicit user-source sync perform bounded Graph reads using tenant application credentials with the initiating user's current app-role and session authority. A new usage import is reflected on the next saved-data read without another provider scan; newly reported identities remain license-unknown until Users sync verifies them. Failed refreshes preserve the last successful source; tokens, jobs and authorization evidence are not shared.

- Users with an active paid Microsoft 365 Copilot entitlement
- Users with reported agent activity
- Licensed users who may need attention
- Licensed users with no activity in the selected reports
- Company and department when Entra ID supplies them
- Agent relationships found in inventory and reports

Microsoft 365 Copilot Chat without a paid Microsoft 365 Copilot license is a
separate experience and is not measured as a paid entitlement.

## Required access

Viewer, UsageReportUploader and Admin can read shared saved data and initiate
read-only sync. New CSV imports require Uploader or Admin; published-report
corrections, selection and deletion require Admin. Local import uses no
Microsoft token. These app roles do not grant Microsoft permissions.

The following Microsoft Graph **application** permissions are the user-data
subset of the current Permissions page's
[11-entry reference](user-roles-and-permissions.md#app-registration-permissions):

| Permission | Source | Required Microsoft access |
| --- | --- | --- |
| `User.Read.All` | Directory users and Copilot license assignments | Application credentials and tenant admin consent; no signed-in Microsoft directory reader role. |
| `LicenseAssignment.Read.All` | Tenant product SKUs and service-plan catalog | Application credentials and tenant admin consent; no signed-in Microsoft directory reader role. |
| `Reports.Read.All` | 28-day per-user Copilot Office-app activity | Application credentials and tenant admin consent; no signed-in Microsoft reporting role. Not the imported agent-usage CSV reports. |

Downloading the original user-level CSVs from Microsoft 365 separately requires
**Reports Reader** or **AI Administrator**; **Usage Summary Reports Reader**
does not include user details. See [deployment setup](deployment-setup.md) and
[usage import](official-usage-import.md).

## Refresh user data

Read-only collection begins automatically after sign-in while the browser is
visible and online. An administrator does not need to remain signed in.
**Sync** shows progress and supports explicit refreshes. The Office app activity
API does not replace the three imported agent-usage CSV exports.

Session-driven automatic refresh uses application Graph reads with the initiating user's session/publication fences. Directory/license evidence and app activity are each due after six hours; their original observation timestamps remain independent. Ordinary failed attempts and authorization or permission failures back off for an hour independently of a healthy other source. A new sign-in can retry an older initiating-session authentication failure once, but does not repair application credentials, bypass a permission denial or ignore a newly failing attempt's cooldown. Failures are not reported as a successful refresh. Missing snapshots are collected when eligible, including authorized empty results. Automatic owner/creator reference enrichment reuses unexpired cached identities instead of forcing every exact lookup. Explicit Users sync still refreshes both source types and referenced people. Explicit incomplete-source retries bypass automatic cadence even when retrying an automatic run, while retaining already successful source snapshots even when stale.

Users refresh retains one account-session generation through authorization, collection and publication. Cancellation or a superseding sign-in stops subsequent token/provider operations and publication after pending authorization returns. Both independent source attempts settle before the refresh finishes, including when one fails unexpectedly, so cancellation and retry do not lose track of the other attempt.
Saved-status reads and the source-publication transaction also recheck that generation after pending work returns, including a final synchronous check immediately before COMMIT; a cancelled or superseded refresh cannot return a current-status result or finish source publication. Each source captures its capability authority generation before the initial saved-data reads and retains it through collection and publication rather than renewing under superseding authority. Report-identity batches, provider pages, signed downloads, report streaming and retries recheck that authority after pending work returns and before further collection. Active sync job attachment, progress and final success-marker/run updates also recheck session, cancellation and admission authority immediately before COMMIT. Graph error-body deadlines preserve an already received HTTP status and `Retry-After`, so authorization denials remain authorization failures and throttling waits retain the provider's delay.
Each source's persisted absolute deadline also cancels pending provider work and is checked synchronously around collection, validation, publication authorization and completion, including immediately before COMMIT even when the timeout callback has not yet run. Counts are captured before publication; post-COMMIT cleanup or observation failures emit `user_source_publication_cleanup_failed` without downgrading a durably published source to a failed or partial outcome.

Microsoft Graph activity and Microsoft 365 Copilot Agents usage reports are
different sources.

To add per-agent and per-user activity:

1. Export **Agents**, **Users & agents**, and **Users** for the same period from
   the Microsoft 365 admin center.
2. Import them through **Sync > Add CSV reports**.
3. Select the report set on the Agents or Users page.

See [Microsoft 365 usage report import](official-usage-import.md).

## How users are classified

Paid-license status requires current saved product and service-plan evidence.
Activity alone does not prove a paid license.

- **Using agents** means the selected report set contains positive response
  evidence for that user.
- **No reported agent activity** means the selected reports support that
  conclusion for a matched licensed user.
- **Needs attention** includes licensed users with no activity or low reported
  usage.
- Missing or concealed identities remain unknown until they can be matched.

- Application `User.Read.All` reads user identity, member type, account state, `assignedLicenses.disabledPlans`, and individual `assignedPlans.capabilityStatus`. Package-level `licenseAssignmentStates` are not requested or used.
- Application `LicenseAssignment.Read.All` reads the tenant's `/v1.0/subscribedSkus` service-plan membership. Product IDs are internal joins to discover candidates and associate their disabled plans with the relevant paid features, not evidence of effective Copilot entitlement. SKU names and catalog provisioning states are not used for user status. No signed-in catalog-reader role is required. The catalog is fully paged before querying users; missing application permission or an invalid catalog makes the active paid-license count unavailable, not a fallback count from a SKU allowlist. Conflicting paid-plan eligibility for the same product ID is rejected even when one record would be excluded from discovery. Null catalog or directory collections are reported as invalid provider responses, independently of the app-activity source.
- Paid Copilot services are recognized only by Microsoft's exact service-plan IDs: `M365_COPILOT_APPS` (`a62f8878-de10-42f3-b68f-6149a25ceb97`), `M365_COPILOT_TEAMS` (`b95945de-b3bd-46db-8437-f2beb6ea2347`), and `M365_COPILOT_BUSINESS_CHAT` (`3f30311c-6b1e-48a4-ab79-725b469da960`). Standalone, education, bundled and future products carrying these services use identical rules. There is no E7 check, dependency, or product-name/SKU allowlist. Free Copilot Chat, Studio-only plans and ordinary base licenses do not qualify without a paid Copilot service plan.
- The `graph.licenses.read` capability uses application `User.Read.All` and `LicenseAssignment.Read.All`; creator/owner resolution and management user lookup also use application `User.Read.All`. Delegated `Group.Read.All` is only for management group lookup. License inventory does not require group-read or license-write access.
- Application `Reports.Read.All` reads `GET /v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D28',version='v2')`, using the [currently supported report version and period](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/copilotreportroot-getmicrosoft365copilotusageuserdetail). No signed-in reporting role is required. The generally available v1.0 operation is consumed as its documented bounded CSV stream; JSON is not requested and the beta JSON contract is not used. Reports use the inclusive 28-day activity window and display D28/v2, including empty reports.
- Candidate discovery uses a separate `assignedLicenses/any(...)` predicate for each product containing a paid Copilot service, joined with `or` outside the lambdas in batches of at most 20 IDs. **Graph applies this filter across the tenant**, rather than the app issuing one license request per account. Each returned page includes `assignedLicenses` and `assignedPlans` for bulk paid-feature verification. This compound filter requires `$count=true` and `ConsistencyLevel: eventual`, including the header on continuation requests. Every continuation is followed, and each batch's unique candidate count must match Graph's first-page `@odata.count`; that count is for the filtered cohort, not all tenant accounts. Any count repeated on a continuation must also match, for both product discovery and exact-identity verification. Disagreement makes the source unavailable and requires refresh, rather than displaying an incomplete total. Discovery alone never sets the paid-feature state. Users assigned multiple products are deduplicated across batches. Recent license changes may take time to appear in Graph's advanced-query index.
- Users sync also reads the selected saved reports and verifies active report identities absent from the discovery cohort through bounded exact UPN/object-ID user queries, using the same catalog and license fields. It does not scan all tenant accounts or infer absence of a license from an unmatched report. A verified directory user with no assigned recognized paid Copilot service is saved with no active paid access; missing, concealed, ambiguous or unverified identities remain unknown. A positive Users-report response total or a positive Users & agents response establishes activity; dates, agent counts and missing metrics alone do not. No snapshot reset is required. Run Users sync after deployment or a new import to verify newly reported identities.
- Catalog and directory pagination completes only when `@odata.nextLink` is absent or `null`. An empty or otherwise invalid continuation is rejected, not interpreted as a complete source. Continuations retain the requested field projection and, for directory queries, the exact filter, `$count=true` and `$top=100`. Only one nonempty opaque `$skiptoken` may be added; changed, duplicate or undocumented query options are rejected before another authenticated request. Graph URLs remain limited to 8,192 characters and the exact endpoint origin/path, without credentials or fragments.
- The report reader accepts a direct CSV response or one HTTP 302 redirect to the exact HTTPS origins `reports.office.com` or `reportsweu.office.com`. Supported paths are query-free `/data/download/<id>` and `/data/v1.0/download?token=<signed-token>`; the latter requires exactly one nonempty token and no other query parameters. The signed download is fetched without the Graph bearer token, under the same deadline and byte limit. Cancellation and the shared deadline are checked again after body completion, before CSV parsing. Other hosts, paths, credentials, fragments, and further redirects are rejected; there is no wildcard Office-domain allowlist.
- The CSV reader requires the shared v1/v2 activity fields by exact, unique header name, regardless of order. Additional v2 activity and prompt-count columns are ignored, not interpreted as new dashboard metrics. Missing or duplicate headers, malformed row widths, invalid required dates, and any period other than the requested 28 days remain errors. The report body is bounded at 64 MiB, and parsing stops at the first row beyond the 100,000-user limit with an explicit result-limit error rather than materializing the remaining records or returning a truncated report.
  Borrowed transport chunks are copied before decoding yields to a backpressured consumer. Transport errors are isolated from Node stream error inspection, so arbitrary error accessors or proxies cannot run while handling a report failure.
  Report dates use positive four-digit years (`0001`–`9999`); year zero is rejected as `provider_schema` before staging rather than reaching PostgreSQL date conversion.

## Troubleshooting small or unexpected counts

Check:

1. The Users source completed successfully in **Sync**.
2. The signed-in account can read the directory, license catalog, and reports.
3. `User.Read.All`, `LicenseAssignment.Read.All`, and `Reports.Read.All` have
   admin consent.
4. The expected products and service plans are assigned and enabled.
5. The selected imported report set is current and uses identifiable names.
6. The report identities match current Entra users.

Users referenced only as agent owners or creators can appear in agent details
without being included in paid-license counts.

## Data boundaries

- **HTTP 400 from the directory:** investigate the Graph query, not additional consent. The license count stays unknown rather than showing zero.
- **Access denied:** the visible source notice identifies the relevant delegated permission and, for Office activity, the report-reader role.
- **Failed report download:** refresh to obtain a new signed download. Allow outbound HTTPS from the app to `graph.microsoft.com`, `reports.office.com`, and `reportsweu.office.com`; do not attach the Graph token to the download request.
- **"You cannot access this right now" during Microsoft sign-in:** this is a tenant sign-in policy/Conditional Access restriction, not a license permission error. Use an organization-approved account, browser, device, and network, or have the tenant administrator review the Entra sign-in logs. The app does not bypass that policy.
- **Office activity unavailable but licensed users visible:** license inventory is working. Resolve report access separately; do not remove or reassign user licenses to repair report access.
- **Directory response-size limit:** inspect `user_source_refresh_failed` with `source: directory` and `errorCode: provider_response_size_limit` in the backend logs. This is not a permission failure or evidence that the tenant has too many licensed users. Directory pages have a dedicated 16 MiB budget; catalog and other generic JSON reads retain the 2,000,000-byte default. The current event does not distinguish catalog from user pages or include observed response bytes.

Provider status and normalized error codes are logged without raw provider bodies, user identities, tokens, or signed download URLs. Persisted source-failure diagnostics read only owned data properties on native application errors; accessors and proxy-wrapped errors/details are ignored without replacing the original collection failure.

## Investigating an unexpectedly small count

**Active M365 Copilot licensed users** (the existing API field `counts.licensedUsers`) is the number of distinct accounts with at least one paid Microsoft 365 Copilot feature verified active or in a usable grace period. "Active" describes paid-feature availability, not recent usage or account sign-in status. Partially active users count once because at least one paid feature is verified usable. Users with paid features not enabled, suspended or locked out are eligible for the second view only with positive reported activity. Wholly unverified licenses are excluded from both current-license cohorts. Missing activity stays unknown.

A tenant with roughly 30,000 accounts can legitimately finish Users sync at 3,993 **checked directory candidates** but have only 2,206 verified active M365 Copilot licensed users. For example, an E7-assigned user with all paid Copilot features disabled is discovered because of the containing product, but is **not** classified as effectively Copilot licensed. Those are different populations, not two counts of the same license cohort. Neither count establishes the number of basic Chat users. There is no 4,000-user cutoff. If Graph instead reports 30,000 matching candidates but only 3,993 arrive, the count check rejects the collection rather than publishing it as complete.

The app reads the tenant catalog and paginated, server-filtered users; it does not need 30,000 individual `/users/{id}/licenseDetails` calls. For a single SKU-filter batch, 30,001 matching users at 100 rows per page take 301 user-list requests plus the catalog read. Regression coverage verifies discovery beyond 4,000 and 20,000 users, complete saved API results, and PostgreSQL publication/readback of 30,001 users with all three paid feature plans. A separate synthetic regression reads 3,993 E7 candidates over 40 user-list pages, preserves the disabled-plan evidence through saved reads, and counts only the 2,206 effectively licensed users in paid adoption. These are synthetic tests, not a claim about any live tenant's current license totals.

A product assignment and effective paid Copilot entitlement are different facts. Neither a standalone product's assignment nor a bundled product's active state proves effective paid Copilot access. A user with all paid features inactive is labeled **No active M365 Copilot license**, not **Paid license assigned**. Unknown evidence is **License not verified**, not proof of being unlicensed. If another current assignment enables a paid feature, that effective entitlement still qualifies the user once. None of these labels establishes basic Copilot Chat access or usage.

For geo-restricted frontends, use the source notices and checked-directory progress in **Sync**. Authorized operational logs can identify failed collections:

- `user_source_refresh_failed`: independent `directory` or `app_activity` source, normalized `errorCode` and error kind/status. Directory examples include `provider_count_mismatch` for incomplete or changing totals, `provider_schema` for conflicting evidence or malformed fields, `provider_response_size_limit` for oversized pages, and `data_generation_rows` for the distinct-user limit.
- `report_download_retry` / `report_download_failed`: app-report download HTTP status and retry attempt, without a signed download URL.

These events contain no raw provider bodies, user identities or tokens. A successful HTTP request alone does not prove a complete license inventory: sources can independently be unavailable. Do not attach a live-process debugger or extract session tokens to investigate; use normal authenticated saved-data reads and aggregate diagnostics. Catalogs remain bounded at **200 pages/1,000 rows**. Product discovery allows **1,000 pages** of up to 100 requested users; exact report-identity verification has a separate **6,000-page** budget for batches of at most 20 identities and continuation allowance. Both phases share a **100,000 distinct directory-user** bound and a **5,000,000 wire-row** bound that also charges duplicate observations. Directory responses retain their dedicated **16 MiB per-response bound**; catalog and other generic JSON reads retain the **2,000,000-byte** default. Directory users and service plans are stored as separate typed rows, not a whole-source JSONB snapshot or a shared service-plan-array encoding. SQL writes are bounded at **250 rows and 1 MiB of encoded parameters** per batch, within the source's **8 GiB generation reservation**. Each user retains its complete feature state, labels, capability status and assignment evidence; the bounded timestamp residual preserves submillisecond precision that the typed database timestamp cannot fully represent. Oversized or conflicting evidence fails without replacing the preceding complete generation. Row bounds, timeouts, cancellation, authorization, duplicate checks and Graph-count reconciliation remain enforced. No migration or saved-data reset is required to enforce these validation rules.

## Identity and data limits

Each reported paid feature must belong to a currently assigned product in the tenant catalog. The user's effective `assignedLicenses.disabledPlans` is checked across every current source of that feature: disabling it in one product does not override an enabled source in another product, including separately purchased Copilot. Repeated entries for the same SKU must agree on their canonical disabled-plan set; conflicting effective assignments fail the source instead of being treated as independent direct/group grants. Equivalent GUID casing, plan order and repeated disabled-plan IDs do not create conflicts. If all current sources disable the feature, its internal state is `disabled`, presented as **Paid features: Not enabled**, even if a historical capability still says `Enabled`. Otherwise, its current capability must supply positive evidence: `Enabled` becomes **Active**, `Warning` becomes **Active (grace period)**, and `Suspended`, `LockedOut` and `Deleted` remain non-active. Missing or conflicting active/inactive capabilities are **Unverified**; there is no package-state fallback. These states describe only paid M365 Copilot features, not overall Copilot access. Catalog provisioning, package assignment errors, account sign-in status and usage activity never substitute for the user's paid-feature evidence.

The existing user-level `copilotServiceState` summarizes only these paid features. A mixture of usable and inactive/unverified paid features is **Partially active**; every individual component's state remains visible in `servicePlans`. The shared `isCopilotServiceActive` rule determines both the positive license label and the licensed cohort: `enabled`, `warning` and `partially_enabled` qualify. An exact verified directory user with no assigned paid service is `disabled` with empty `servicePlans`; an assigned SKU missing from the fully read catalog keeps a negative-license conclusion `unknown`, unless an active paid feature is independently proven. The service-state enums and saved snapshot format are unchanged. An account disabled for sign-in is labeled separately. Historical `assignedPlans` alone do not establish current paid Copilot entitlement.

Each service plan's `assignedDateTime` retains the latest reported assignment instant, normalized to UTC ISO format without discarding submillisecond precision. Nonempty provider values must have a valid calendar date/time and an explicit UTC marker or numeric offset; timezone-less values, date-only/free-form strings and impossible dates fail the source rather than depending on the server timezone or silently rolling forward. Absent dates remain `null`. Equivalent offsets, fractional-second spellings, or observation order do not create false conflicts when the same user appears on multiple pages or in overlapping product batches. A newer assignment time does not override conflicting capability evidence; genuinely different assignment instants still trigger duplicate-record conflict detection.
Both the supplied date and its normalized UTC instant must remain within years `0001`–`9999`. Offsets crossing either boundary fail with `provider_schema`, preserving the storage and frontend's positive four-digit-year contract.

Paid-feature details display the UTC calendar date for these timestamps, including
values with more than nine fractional-second digits within the 128-character
timestamp bound. Display precision does not alter the saved evidence or the
effective paid-feature state.

Imported Copilot Agents usage and app activity are joined only by a unique, trimmed and case-normalized exact UPN or directory object ID. Compatibility Unicode folding used by report indexes/search is not identity evidence: a full-width username cannot become an ASCII directory identity or poison a valid identity's aliases. Exact verification validates the original report username, not its index key. Every possible exact report row counts toward uniqueness, including duplicate case-normalized report identities and ambiguous directory keys; a separate object-ID alias cannot bypass those conflicts. Display names, report pseudonyms, and heuristic aliases are never used. Unmatched or ambiguous imported identities are counted in `summary.unresolvedIdentities`; concealed app-report identities remain unmatched.

Graph directory object IDs use the GUID format without UUID-version or variant restrictions. Users collection, saved reads, deep links and paid-feature details accept that same format and canonicalize GUID casing. Exact opaque imported-report identifiers retain their original spelling.

Directory, app-report, and imported-report availability are independent. Permission, provider, schema, continuation-link, timeout, page, or result-limit failures are explicit and never produce a silently truncated list. Missing report rows stay `null` in the API. The shared activity classifier distinguishes identifiable absence from current reports (**no reported agent activity**) from unavailable reports or uncertain identity matches (**unknown**).

Imported response counts and last activity describe **Copilot Agents** only. They are not total Microsoft 365 Copilot activity and do not establish that a license is unused. The current D28/v2 Microsoft report supplies per-app last-activity dates for Copilot Chat, Teams, Word, Excel, PowerPoint, Outlook, OneNote, and Loop; Microsoft documents that these latest dates are independent of the selected period. Inactive-app attention therefore compares the retained date with that report's refresh window: 28 days for current v2 reports and 30 days for retained D30/v1 reports, without reinterpreting old snapshots. A blank can also reflect new-license or delayed Office telemetry and is not proof of never-used. The dashboard does not infer per-user agent events or generate daily activity logs.

App-report freshness is recalculated on each saved-data read, not frozen at collection time. A report is stale when its whole-day age after the refresh date's UTC end-of-day exceeds three days. Last-known dates and the original collection timestamp remain visible, but stale app activity does not contribute to measured-activity counts or inactive-app attention. Independently fresh imported agent usage can still contribute to its own metrics.

Partial app-report coverage does not invalidate uniquely matched, fresh rows: their per-user inactive-app attention remains usable in dashboard counts, cohorts and details. Unmatched identities and blank dates stay unknown. A failed refresh retains prior dates, but cannot hide their stale label or make stale app activity eligible for recommendations.

## Users: paid users and active users without paid Copilot

The **Adoption** tab groups saved users and all agents used by company
and department, with five groups per page. Paging keeps the current groups and
summary visible while the requested page loads. A single set of numbered controls
below the groups shows the current range, total, and page, with first/last pages and
ellipses for larger result sets. **Go to page** jumps directly to any valid page
without fetching intermediate pages. Explicit navigation focuses the results
heading; background refresh never moves focus or scroll. Automatic source
publications
and saved-selection renewal keep the first visible group as the page anchor
instead of returning to page one. Search and filter changes intentionally start
at the beginning of the new results.

Group identities, organization filters, search and facets share Unicode
compatibility normalization and case folding, including normalization after
lowercasing. Paging cursors retain a bounded group identity rather than the
organization labels, so long saved labels do not prevent page navigation.

`GET /api/copilot-usage/adoption` returns the first group's identity in
`page.anchor`, and its one-based page and zero-based group offset in `page.number`
and `page.offset`. `pageNumber` requests a numbered page within the same selection.
Positive page numbers beyond the available results resolve to the last page,
including when refreshed results shrink. A fresh read can send the group identity
as `anchor` to resume at the page containing that group with a newly validated
selection and newly signed previous/next cursors. An anchor is a position hint,
not authorization or an immutable filter; only one of `anchor`, `pageNumber`,
and `cursor` may be supplied. It is resolved only within the current principal's
matching groups. If that group no longer exists in the results,
the read starts at the first matching group. Expired or rejected evidence never
becomes actionable merely because its content remains visible during loading.

Each Adoption selection pins the directory and the selected usage reports.
Agent lists, counts, champions, filters and facets use the same saved dependencies
across pages. Published inventory and its source revisions are optional enrichment
for saved descriptions and verified inventory-detail links; missing, empty or
reconciling inventory does not hide reported agents. Report-only agents remain
visible with their reported names and creator labels, without a broken inventory
detail link. Automatic publication refresh captures new report data and optional
inventory metadata without manual page refresh. Clearing saved data and
authorization changes invalidate the affected selection. Usage-association changes
also invalidate selections that captured inventory enrichment.

The Agents column deduplicates exact report agent IDs with positive responses
from people uniquely matched to each group in the selected reporting period.
Organization-built, Microsoft-built and third-party agents are included, even
without an inventory match or an Agents-summary report. Shared agents appear in
every group that used them, but count once in the overall **Agents used** summary.
Created-but-unused agents and zero-response relationships are not usage.
A person's `Agents / responses` value combines their distinct positively used
report-agent count with their total reported agent responses. User details retain
all reported relationships, including zero-response rows, so their row count can
still exceed the Adoption usage count. Missing Users & agents reports produce
unknown agent counts, not measured zeroes; a published empty report produces zero.
Neither **With agent usage** nor **Without agent usage** classifies missing usage
as a measured result.

Up to three **Copilot Champs** per group are ranked by reported responses
descending, distinct agents used descending, lowercase name and exact user
identity. Positive reported responses or positive agent usage qualify; inventory
creation does not qualify or boost a person. The MCP champion view uses the same
ranking and separately exposes each champion's authorized created/used
relationships.

A view dropdown defaults to **Paid M365 Copilot users** and also offers **Active users without paid Copilot**. The default view shows users with verified active paid features, including grace-period and partially active users and those with zero or unavailable activity. **Using agents**, **Needs attention**, **No reported agent activity**, and their adoption cohorts use that same licensed population. The API's `measuredActivityUsers`, `needsAttentionUsers` and `unknownMetricsUsers` also exclude inactive/unverified candidates. Measured activity includes positive evidence from either agent report or recent Office-app activity; unknown metrics covers uncertain agent activity or missing app evidence. The **All checked users** and **Unlinked report identities** sections are not shown, and the checked-directory-count/scope banner is removed.

The paid view shares the non-paid view's search, matching count, **Filters** popup, removable chips, and table layout. Its popup contains **Company**, **Department**, **Activity**, **Low-response threshold**, and **Sort**. Organization dropdowns use all effectively licensed users in the saved snapshot and combine as exact, trimmed matches before 50-row paging. The Activity dropdown and summary cards select the same cohort. Clear and Reset preserve sorting; invalid thresholds show an error and retain the last valid filter.

Both tables show the user, agent responses, agents used, company, department, and last activity. Paid-feature status and follow-up recommendations are available in user details rather than repeated in each row. Paid filtering, sorting and paging operate locally on the saved snapshot. Last activity comes from the Users report; Office-app dates remain separate in details. Unavailable sources retain concise recovery messages.

Select a paid user to inspect their effective paid Copilot classification, named paid features and individual states, agent response totals and separate Office-app last-known dates. No containing product or SKU state is displayed. Agent breakdowns remain searchable and paginated within user details; paid-user links do not send the person into the unpaid-only table. Technical service-plan IDs and coverage stay collapsed.

**Active users without paid Copilot** uses `GET /api/official-usage/users?licenseCohort=active_without_paid` for a server-paginated user table, at most 50 rows. The server selects only uniquely linked, verified non-paid users with positive reported agent activity before search, sorting, counts, rankings, paging and export. Current licensing comes from the latest successful tenant Users sync; activity can come from any selected retained reporting period. No historical licensing analysis is performed. When a subsequent sync verifies a paid license, the user moves to the paid cohort regardless of when activity occurred.

The optional `licenseCoverage` response describes available/unavailable verification, its observation timestamp, and paid/unpaid/unknown counts among active report identities before user filters. Unmatched, concealed, ambiguous and unknown licenses are excluded with a compact recovery notice, not classified as unpaid. A failed, missing or expired directory source makes the unpaid cohort unavailable and disables export. A bridge-only identity with a positive response can qualify after exact license verification; its missing Users-report totals remain **Unknown**, never replaced by a relationship sum. The unfiltered report API remains available for report-specific analytics and does not silently acquire this cohort restriction.

Expired directory evidence is not a measured empty non-paid cohort: the table shows licensing as unavailable, not zero matching users, and cannot start a new export. While automatic license verification is queued or running, missing cohort counts show **Updating...** and the empty state describes verification in progress. A successful Users publication restores the matching count, rows and new exports automatically, without a separate enable action.

The toolbar matches Agents: search, matching count, **Filters**, removable chips, and CSV export. The shared filter popup applies changes immediately and contains **Company**, **Department**, response cohort, low-response threshold, and sort order. Company and department are dropdowns populated from the entire eligible saved cohort, not just the visible page. They combine as exact, trimmed matches before search, sorting, paging and CSV export. Missing organization fields are shown as **Not set** and do not match a selected value. Clear and Reset preserve sorting. Date bounds, user recency, relationship creator and response-producing controls are no longer shown; existing API clients can still use those query parameters.

The table shows company and department instead of repeating the same license label on every row. Select a user's name to open details. **Report sources** contains source dates and row counts only; query failures and unavailable licenses retain concise recovery messages.

The keyboard-accessible detail dialog keeps Users-report totals and the sum of Users & agents rows separate. Its agent list searches all relationships, pages at 50 rows and initially respects an exact-agent filter; **Show all this user's agents** reveals the complete breakdown. Selecting an agent focuses its exact report ID and retained snapshot and clears prior filters. Response cohorts use Users totals; unknown totals do not qualify for zero/low cohorts.

User details use the shared metric-card and profile-grid styles, with a padded,
scrollable tab panel beneath the heading and tabs. Loading and error messages,
including retry actions, stay inside that panel rather than touching the dialog
edges or pushing navigation out of view on narrow screens.

The dialog retains the presentation from `7e2be0b6`: **Overview** shows license
and Users-report metrics, report dates, organization, and last reported agent
activity. **Usage & agents** keeps the searchable agent breakdown and separate
Office-app activity cards; **Licenses**, **Responsibility**, and **Purview audit**
remain dedicated tabs. These views use the current selection-scoped, paginated
APIs. Database storage details and provenance controls do not replace the user
summary, and missing evidence is never presented as zero.

Missing relationship evidence is not a mismatch with the Users report: discrepancy labels require both a Users row and a reported relationship breakdown. A missing companion is labeled unavailable, separately from a present report containing no rows for that person. Report-wide Users response totals are `null` when the Users report is absent; a present report can total zero, including a known-empty export. User rows contain relationship totals, not complete relationship arrays: the selected user's `/agents` endpoint pages those rows independently. Server filtering and totals examine the full selected relations before paging.

The scoped response uses `entitlement=paid_inactive` or `entitlement=no_paid` from the current verified directory source. Unfiltered report rows can also carry `paid_active` or `unknown`; `entitlement` is `null` when no exact directory identity is linked. Exact directory matching is shared with paid adoption, rejects ambiguous case-distinct identities and multiple report aliases for one directory object, and never joins by display name. Retained report periods do not affect current license classification. Optional richer user details still require the same report-set/version linkage as the saved paid-user response. **License not verified** never means basic or unlicensed, and neither cohort establishes whether agent usage was free.

CSV export pins the displayed `selection.id`, including its report/source revisions and `licenseCohort=active_without_paid` query, and applies company, department, search, response cohort and ordering across **all matching people**, not just the page. Every matching user's agent relationships are exported, including those outside an exact-agent filter. Repeated Users totals are not additive across relationship rows. Export is disabled for invalid thresholds, pending filter reads, unavailable licensing, or failed reads. The pinned report and saved licensing dependencies are revalidated before export publication; an invalidated selection requires reload/retry. Snapshot/query changes and leaving the page abort outstanding reads/exports. Failures have local retry actions; 401/403 failures clear retained private data.

Explicit `copilot_users` export IDs use case-insensitive directory object IDs and are stored lowercase; case-variant duplicates are rejected. Official report usernames and agent IDs remain case-sensitive, including UUID-shaped values.

CSV retains a row for matching people without relationships. Absent Users metrics have `userMetricSource=unknown`; absent relationship response totals are `Unknown`, not inferred zero. Saved-user refreshes invalidate verified entitlement labels and opened details even when the revision returns to an earlier value. Switching Users subviews also closes licensed-user details rather than reopening them on browser-history return.

The signed-in workbench retains at most four inactive first-page reads
(user cohorts, report summaries and report-selector options) in memory for
30 seconds. Returning to a recently loaded page or filter can reuse it without
another capture or aggregate calculation. Cache
keys include account/tenant/roles, report, filters and data revision; selection
expiry, source/report revision changes, explicit restart and session teardown
prevent reuse. Focus revalidates the selected evidence. Continuations and detail
pages are not retained by this cache. A rejected selection withdraws peer
evidence for the same selected query, including other local revisions, and
cancels their pending reads; late cancelled responses cannot restore it.
After its last observer leaves, that rejected cache entry is discarded so the
next visit can retain a fresh capture. Uncached filters start a fresh
selection. Nothing is saved to browser storage. During a replacement read,
old source-freshness notices are withheld; genuine stale/unavailable results
and persistent read errors remain visible after the read settles. Routine
source refreshes do not show warning banners. A running attempt does not
downgrade an unexpired, successfully published source: its saved counts and
rows remain usable until replacement data is published. Missing or expired
sources, incomplete coverage and failed/unauthorized attempts remain explicit.
Sync and the expandable source details retain collection progress.

Canonical activity links use `/users?view=activity` and preserve exact agent/search/snapshot values with selection-bound cursors. Users owns licensing/reported-user activity; Agents owns current agent usage. Collection/import belong to **Sync**; retained reports use `/sync?reports=manage`, and an exact read-only snapshot uses `/sync?reports=snapshot&snapshot=ID`. Provider-event investigation is explicit through user/agent Logs with its real permission requirements; the top-level **Audit** is administrative actions, not usage or prompt/response content.

## Agent responsibility in user details

The **User cohort** selector contains only paid M365 Copilot users and active users without paid Copilot. The former **Agent responsibility** cohort and standalone people list are removed. Responsibility lives in the user modal's **Responsibility** tab, showing an agent count, compact linked agent rows, explicit **Owner**, **Created by** and **Last modified by** badges, source observation dates, and paged results. A last modifier is not necessarily an owner or ongoing maintainer; these relationships do not grant access or management permissions.

Partial inventory coverage alone does not show a warning banner or direct the user to refresh manually. Saved relationships remain visible, and scheduled inventory refresh is unchanged. Failed reads and unavailable responsibility data still have explicit error or unavailable states.

Responsibility pages retain the exact selection ID, revision, evaluation time and expiry; paging cannot renew or replace that selection. Selections last at most ten minutes and can expire earlier with their sources. While a saved read is refreshing, its previous relationships may remain visible, but cancelling an invalidated read withdraws them and offers **Retry saved responsibility**. Retrying captures a fresh first page rather than silently resuming the old cursor.

Collection coverage comes only from the saved source metadata. Missing owner, creator or last-modifier fields do not make a successfully collected inventory partial, and Graph-only agents are not required to provide Power Platform relationships. Reported roles remain available independently; malformed identity references are counted separately and never guessed into user relationships.

Agent-person links use `/users?detail=<exact-object-id>&tab=responsibility`. Exact saved Power Platform references and the private people cache preserve responsibility for people outside both rosters. Their saved profile is read independently; missing profile/licensing/usage remains explicit without hiding known responsibility. Unresolved/concealed report identities are never matched by name. Browsing makes no provider call or directory sync and does not change paid-feature or report metrics.

## Current combined-query contract

The runtime user/report SQL, source/null semantics, paged children and export
schemas are documented in [Saved-data architecture](data-architecture.md#official-reports-and-user-evidence)
and implemented by the current record-backed provider, selected-read services
and frontend consumers.
