# Microsoft 365 Copilot license usage

`GET /api/copilot-usage/users` is a read-only Viewer/Admin view of saved tenant/principal-private directory/license and app-activity snapshots. It joins those saved sources to the current imported official Copilot Agents usage set without calling Microsoft Graph. First-use setup and explicit user-source sync perform the bounded delegated Graph reads. A new usage import is reflected on the next saved-data read without another provider scan. One user's delegated snapshot is never shared with another principal.

Data sync distinguishes an uncollected source from an authorized collection with zero licensed users. A failed resync does not erase the last successful data. Source timestamps and errors remain visible; saved state is not represented as a fresh live observation. Syncing does not change license assignments or create synthetic activity.

## Provider requirements

- `User.Read.All` reads user identity, member type, account state, `assignedLicenses`, and `licenseAssignmentStates`.
- `LicenseAssignment.Read.All` reads the tenant's `/v1.0/subscribedSkus` catalog. The signed-in principal also needs a supported catalog-reader role, such as Directory Readers or Global Reader. The catalog is fully paged before querying users; missing permission or an invalid catalog makes the license count unavailable, not a fallback count from a short SKU list.
- A user-scoped product qualifies when its catalog entry contains the exact `M365_COPILOT_APPS` service-plan ID (`a62f8878-de10-42f3-b68f-6149a25ceb97`). This includes bundles such as `Microsoft_Copilot_for_Sales`, not just standalone Copilot products. The documented standalone IDs `Microsoft_365_Copilot` (`639dec6b-bb19-468b-871c-c5c441c4b0cb`), `M365_Copilot` (`a809996b-059e-42e2-9866-db24b99a9782`), and `Microsoft_365_Copilot_EDU` (`ad9c22b3-52d7-4e7e-973c-88121ea96436`) are also recognized when present in the catalog. Product names containing "Copilot", a Studio-only plan, and ordinary Microsoft 365/Office 365 base licenses do not qualify by themselves.
- The `graph.licenses.read` capability requests `User.Read.All` and `LicenseAssignment.Read.All` independently of package principal resolution, which retains `User.ReadBasic.All` and `Group.Read.All`. License inventory does not require group-read or license-write access.
- The separate `Reports.Read.All` capability reads `GET /v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D30',version='v1')`. The delegated principal must also hold one of the roles listed by Microsoft for this operation, including Reports Reader or AI Administrator. The generally available v1.0 operation is consumed as its documented bounded CSV stream; JSON is not requested and the beta JSON contract is not used.
- License filtering uses a separate `assignedLicenses/any(...)` predicate for each discovered SKU, joined with `or` outside the lambdas in batches of at most 20 SKUs. This compound filter requires `$count=true` and `ConsistencyLevel: eventual`, including the header on continuation requests. Every continuation is followed, and each batch's unique user count must match Graph's first-page `@odata.count`; disagreement makes the source unavailable and requires refresh, rather than displaying an incomplete total. Users assigned multiple qualifying products are counted once across batches. Recent license changes may take time to appear in Graph's advanced-query index.
- The report reader accepts a direct CSV response or one HTTP 302 redirect to the exact HTTPS origins `reports.office.com` or `reportsweu.office.com`. Supported paths are `/data/download/<id>` and `/data/v1.0/download?token=<signed-token>`; the latter requires one nonempty token. The signed download is fetched without the Graph bearer token, under the same deadline and byte limit. Other hosts, paths, credentials, fragments, and further redirects are rejected; there is no wildcard Office-domain allowlist.
- The CSV reader requires all v1 fields by exact, unique header name, regardless of order. Microsoft can include additional activity and prompt-count columns even for `version='v1'`; those columns are ignored, not interpreted as new dashboard metrics. Missing or duplicate headers, malformed row widths, invalid required dates, and unexpected report periods remain errors.

Normal sign-in includes these implemented delegated permissions in the consent request. Existing sessions may require sign-out/sign-in or explicit consent after deployment.

## Permission and connection recovery

No separate delegated app registration is needed. On the **existing** Entra app registration, check **API permissions > Microsoft Graph > Delegated permissions** for `User.Read.All`, `LicenseAssignment.Read.All`, and `Reports.Read.All`, and grant tenant admin consent for missing permissions. Catalog discovery adds `LicenseAssignment.Read.All` to the previous dashboard requirements; existing deployments need consent and a fresh sign-in. `User.ReadBasic.All` is not sufficient for license details. Application permissions and license-write permissions are not needed.

The signed-in account must also have an Agent Control Viewer/Admin app role. Tenant license-catalog access requires a supported Microsoft Entra role such as **Directory Readers** or **Global Reader**. Office usage separately requires an eligible role such as **Reports Reader** or **AI Administrator**; app permission consent does not assign these roles. After permission or role changes, sign out and sign back in, then choose **Refresh usage**. The MSAL token cache is in memory, so an app restart also requires fresh sign-in even when the browser session cookie survives.

The dashboard reports license inventory, Office activity, and imported agent usage independently:

- **HTTP 400 from the directory:** investigate the Graph query, not additional consent. The license count stays unknown rather than showing zero.
- **Access denied:** the visible source notice identifies the relevant delegated permission and, for Office activity, the report-reader role.
- **Failed report download:** refresh to obtain a new signed download. Allow outbound HTTPS from the app to `graph.microsoft.com`, `reports.office.com`, and `reportsweu.office.com`; do not attach the Graph token to the download request.
- **"You cannot access this right now" during Microsoft sign-in:** this is a tenant sign-in policy/Conditional Access restriction, not a license permission error. Use an organization-approved account, browser, device, and network, or have the tenant administrator review the Entra sign-in logs. The app does not bypass that policy.
- **Office activity unavailable but licensed users visible:** license inventory is working. Resolve report access separately; do not remove or reassign user licenses to repair report access.
- **Directory response-size limit:** inspect `copilot_license_response_size_limit` in the backend logs. `source` identifies the catalog or directory response; `length` is the number of bytes observed when the stream was stopped, and `maximumLength` is its byte budget. This is not a permission failure or evidence that the tenant has too many licensed users. Directory pages have a dedicated 16 MiB budget; catalog and other generic JSON reads retain the 2,000,000-byte default.

Provider status and normalized error codes are logged without raw provider bodies, user identities, tokens, or signed download URLs.

## Investigating an unexpectedly small count

"Licensed users" is the number of distinct accounts currently assigned a qualifying **Microsoft 365 Copilot** product. It is not all Microsoft 365 licensed accounts, purchased/unassigned seats, free Copilot Chat users, or the number of people appearing in the imported agent report. Accounts without reported agent activity remain in the license cohort with unknown usage.

The previous three-SKU-only implementation could omit Copilot-including bundles. The catalog-based implementation discovers those products from the tenant rather than assuming the three IDs describe every entitlement. A higher tenant total must still be verified; the presence of thousands of base Microsoft 365 licenses does not prove thousands of paid Copilot assignments.

For geo-restricted frontends, inspect the connected backend container's logs after **Refresh usage**:

- `copilot_license_catalog`: total catalog rows, qualifying SKU count, and catalog pages.
- `copilot_license_directory_page`: page number, returned rows, Graph's batch total, distinct observed users, and whether continuation is present.
- `copilot_license_inventory`: final distinct licensed users, total observed rows, directory pages, and qualifying SKU count.
- `copilot_license_response_size_limit`: endpoint, observed response bytes, and byte budget; no payload, identity, or token is logged.
- `copilot_license_result_limit`: Graph's reported user count when it exceeds the configured row bound.
- `copilot_usage_source_unavailable`: normalized failure code, including `provider_count_mismatch` for incomplete or changing directory totals.

These events contain aggregate counts only. A successful HTTP request alone does not prove a complete license inventory: sources can independently be unavailable. Do not attach a live-process debugger or extract session tokens to investigate; use the normal authenticated snapshot and its aggregate logs. Catalogs are bounded at 1,000 rows; directory reads at 200 pages/100,000 observed rows, under the existing snapshot deadline. Directory requests use 100-user pages with a dedicated **16 MiB per-response bound**: a page can exceed the generic 2 MB limit when each enterprise user carries hundreds of service-plan records. Catalogs and other generic JSON reads retain the **2,000,000-byte** default. Streams are cancelled when over budget or aborted. No page, row, concurrency, timeout, or completeness check is relaxed.

## Identity and data limits

Directory users are included only when an exact qualifying tenant-catalog SKU ID is assigned. Catalog service-plan provisioning status, consumed seats, and user activity do not filter assignment discovery: assigned-but-disabled products remain visible for follow-up. Assigned SKU state, disabled plan IDs, and relevant plan `capabilityStatus` values remain separate; `Warning` is retained as a usable grace-period status rather than mapped to disabled. Historical `assignedPlans` alone do not establish a current license. Imported Copilot Agents usage and app activity are joined only by a unique, case-normalized exact UPN or directory object ID. Display names, report pseudonyms, and heuristic aliases are never used. Unmatched or ambiguous imported identities remain in `unresolvedImportedIdentities`; concealed app-report identities remain unmatched.

Directory, app-report, and imported-report availability are independent. Permission, provider, schema, continuation-link, timeout, page, or result-limit failures are explicit and never produce a silently truncated list. Missing usage stays `null`/unknown rather than becoming zero or “unlicensed.” License state is separately reported as assigned, enabled, disabled, or error.

Imported response counts and last activity describe **Copilot Agents** only. They are not total Microsoft 365 Copilot activity and do not establish that a license is unused. The D30 Microsoft report supplies per-app last-activity dates for Copilot Chat, Teams, Word, Excel, PowerPoint, Outlook, OneNote, and Loop; Microsoft documents that these latest dates are independent of the selected period. D30 inactive attention therefore compares the retained date with the report refresh window. A blank can also reflect new-license or delayed Office telemetry and is not proof of never-used. The dashboard does not infer per-user agent events or generate daily activity logs.

## Dashboard and event investigation

The Users page leads with all currently licensed users, most/least agent-response rankings, coaching cohorts, and unknown coverage. Search, ranking, thresholds, and 50-row paging operate locally on the bounded snapshot; use **Refresh usage** for a new provider read. Technical provenance and unlinked imported identities are collapsed below the table.

Select a user to see their license assignment, exact service-plan states, Microsoft-built and other agent response totals, and Office-app last-known dates. **Search interaction log** opens the existing Purview CopilotInteraction search with that user's exact UPN prefilled. The search starts only on explicit confirmation, under the existing `AuditLogsQuery.Read.All` capability and provider prerequisites. Its timestamped audit metadata is not an official usage counter and does not expose prompt/response content.
