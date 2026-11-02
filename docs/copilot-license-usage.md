# Microsoft 365 Copilot licenses and usage

Use **Users** to review paid Copilot entitlement and reported agent activity.
Use **Dashboard > Copilot in Office apps** or **Users > Adoption > Office apps**
for Word, Excel, PowerPoint, Outlook, OneNote, Loop and Teams adoption.

These views read saved tenant data. Opening a page, changing filters or exporting
results does not call Microsoft Graph.

## Required access

Every Viewer-capable app role can read shared saved data and initiate read-only
sync. Graph collection uses the application's credentials and application
permissions with administrator consent, not a Microsoft directory or report-reader
role on the signed-in person. No administrator needs to remain signed in.

For grants and role assignments, use the canonical
[roles and permissions reference](user-roles-and-permissions.md).
The exporting account's Microsoft role for manual agent CSV downloads is
[a separate requirement](user-roles-and-permissions.md#csv-downloads-and-report-import).

## Refresh user data

Read-only sync starts automatically after sign-in while the browser is visible
and online. **Sync** shows progress and supports explicit refreshes.

Directory/license evidence and Office-app activity collect independently.
Routine collection is due every six hours; failed automatic attempts normally
wait an hour, subject to provider backoff. A failed refresh preserves the last
successful source and exposes its age/error rather than publishing a partial
result. Explicit incomplete-source retries retain sources that already succeeded.

Agent activity requires the separate **Agents**, **Users & agents**, and **Users**
CSV imports. A changed usable default report makes directory verification due
automatically; newly reported identities remain license-unknown until that
verification succeeds. Personal report viewing does not alter this sync state.
See [export and import instructions](official-usage-import.md).

## Users: paid users and active users without paid Copilot

Open **Users** and choose a cohort:

| View | People included |
| --- | --- |
| **Paid M365 Copilot users** | Users with at least one verified usable paid feature, including grace-period and partially active users; zero or unavailable usage does not exclude them |
| **Active users without paid Copilot** | Uniquely matched, currently verified non-paid users with positive reported agent responses |

Unknown licensing is not unpaid licensing. Concealed, unmatched or ambiguous
identities are excluded from the non-paid cohort with a coverage notice.
Wholly unverified paid-feature evidence does not establish either cohort.
Neither view measures basic/free Copilot Chat use.

1. Use search and **Filters** to narrow company, department, activity, low-response
   threshold and sort order.
2. Select a summary card to filter the paid-user table.
3. Select a person for **Overview**, **Usage & agents**, **Licenses** and
   **Responsibility** details.
4. Export the verified matching results when needed.

Filtering, sorting, counts and pagination run **server-side against saved data**,
not against only the browser's visible page. Company and department options come
from the eligible saved cohort. Missing organization fields appear as
**Not set**, not an inferred department.

The four paid-user summary cards remain organization-wide within the selected
report/source context. Search, organization filters, selected cards and paging
change the table and export, not those totals. The low-response threshold affects
the corresponding attention calculation.

| Paid-user measure | Meaning |
| --- | --- |
| **Active M365 Copilot licensed users** | Verified usable paid-feature availability, not recent use or account sign-in activity |
| **Using agents** | Positive response evidence in the selected agent reports |
| **Needs attention** | Licensed users with no/low reported usage or qualifying inactive-app evidence; a review cohort, not a license-removal instruction |
| **No reported agent activity** | Matched licensed users for whom available reports support absence of reported activity |

Missing reports, uncertain identity matches or missing metrics remain unknown.
They are not converted into measured inactivity.

### User details and exports

**Overview** shows paid-feature classification, organization and Users-report
metrics. **Usage & agents** keeps the searchable, paginated agent breakdown and
separate Office-app dates. **Licenses** shows the individual paid features and
their states. **Responsibility** shows saved owner/creator/modifier relationships.

User responses, agents used and user last activity come from the **Users** CSV.
Relationship totals from **Users & agents** stay separate. Bridge-only positive
responses can establish activity, but do not replace missing Users-report totals.
Zero-response relationships remain visible without counting as positively used
agents.

Downloads cover all matching people, not just the page, under the displayed
saved selection. Official report-user downloads include every relationship of
matching people, even outside the relationship filter that selected them.
Repeated user totals are not additive. Pending filters, failed reads or
unavailable non-paid license verification disable export.

## How users are classified

A product assignment is not proof of effective paid Copilot access. The app
discovers products containing recognized paid Copilot service plans, then checks
the user's current assignments, disabled plans and capability evidence.
Product names, catalog provisioning status, activity and historical assignments
do not substitute for that evidence.

| Paid-feature evidence | Display / cohort effect |
| --- | --- |
| Enabled | **Active**; qualifies as paid |
| Warning | **Active (grace period)**; qualifies as paid |
| Usable and inactive/unverified features mixed | **Partially active**; qualifies once because at least one feature is usable |
| Disabled in every current assignment | **Paid features: Not enabled**; not active paid access |
| Suspended, locked out or deleted | Not active paid access unless another paid feature is usable |
| Missing or conflicting effective evidence | **License not verified**, not proof of being unlicensed |
| Verified identity with no assigned paid service | No active M365 Copilot license |

Disabling a feature in one product does not override another current assignment
that enables it. Account sign-in status is displayed separately. The saved
directory includes discovery candidates and exactly verified active report
identities, not tenant headcount or an already-filtered list of licensed users.
The [technical entitlement contract](data-architecture.md#official-reports-and-user-evidence)
identifies the recognized plans.

## Personal report context

The **Report set** dropdown on Users and Agents is reader-personal.
**Latest report** follows the newest available content period, not the latest
upload. A selected report carries through navigation and bookmarks using
`snapshot`; returning to Latest removes the pin.

The same retained report can be interpreted with **current saved license
evidence**. Historical licensing is not reconstructed. After verification of a
paid feature, a person leaves the non-paid cohort regardless of when the selected
activity occurred.

Deleted or expired report choices recover to Latest with a notice. A permission
or service error does not silently select a different report.
See [report selection](official-usage-import.md#choose-the-report-set-shown-in-agents-and-users)
for the agent dialog's separate local period controls.

## Office adoption saved-read contract

Office adoption is prepared automatically from saved directory/license data and
the **D28/v2** per-user Microsoft report. It does not depend on agent CSV imports,
inventory or an administrator's session.

| Measure | Meaning |
| --- | --- |
| Saved licensed people | Exact directory identities with usable paid features when captured; not tenant headcount |
| Reported active Office users | Distinct saved licensed people with recent qualifying evidence in at least one of the seven apps |
| Participation | Reported active Office users / saved licensed people |
| Per-app active users | People with qualifying evidence in that app; app populations overlap |
| User-app pairs | One pair per person/app, so one person using three apps contributes three pairs but one active person |
| No recent reported Office evidence | No qualifying app date in the observation's window; not proof of inactivity or license waste |
| Unknown Office evidence | A subset of no recent evidence, with explicit missing/ambiguous/invalid/retained-evidence reasons—not a separate disjoint population |

Recent means the provider refresh date minus 27 days through that refresh date,
inclusive in UTC. Older dates remain visible but are not recent. Copilot Chat,
Edge, overall last activity and agent activity do not contribute to these seven
app metrics. There are no prompt-volume, ROI or productivity measures.

Imported response counts and last activity describe **Copilot Agents** only.
The current D28/v2 Microsoft report supplies separate per-app last-activity
dates; these latest dates can fall outside the selected period. Compare them
with the report's refresh window, not the CSV upload date or today's date.
Missing or invalid source inputs make metrics unavailable, not a dated zero.

Partial coverage makes participation a **confirmed-participation lower bound**.
Blank dates can reflect delayed telemetry or a new license; they are not proof
of never-used. Retained unseen rows keep their original dates and unknown
classification rather than becoming current participation.

### Retained history

Office history keeps one aggregate point per UTC Monday-start week for twelve
calendar months, using the provider refresh date. Each point represents the
latest real D28/v2 report refreshed that week—not activity occurring only during
that week.

| Dataset | Available detail |
| --- | --- |
| Latest current observation | Captured people, paid-feature context, organization, seven app dates and evidence gaps |
| Weekly history | Organization and company/department aggregates; no archived person records |

Licensing and company/department are captured context, not daily workforce
history. Later license or department changes do not recompute older totals.
Repeated identical evidence preserves a capture; a newer report or correction
within a week replaces that week's aggregate point.

Frozen observations retain their measured metrics as source data ages.
Current source freshness is disclosed separately. For current saved-user
attention signals, stale app evidence does not qualify as recent measured use
or an inactivity recommendation; last-known dates remain visible.

## Dashboard and Office Users navigation

Dashboard defaults to **Agent adoption**. Choose **Copilot in Office apps** for
paid-user participation, app adoption, department gaps and seven app history
graphs.

- Organization cards and trends stay organization-wide; company selection narrows
  the department panel.
- A shared measure control switches all app graphs between active users and share
  of enabled users. App counts overlap and must not be added as distinct people.
- Graphs use available weekly observations in the last 30 calendar days up to the
  selected report. Fewer than two points show a history-building notice.
- The default comparison uses a measured point about four weeks earlier when
  available, showing its actual date. Shorter history is identified; missing
  daily activity is not interpolated.
- Rate changes are percentage points, rounded to the nearest tenth. Smaller
  nonzero changes retain their direction and show `<0.1`; denominator changes
  are disclosed.

In **Users > Adoption**, choose **Office apps**. Search and company/department
filters select groups; five-group pages and separate people pages keep large
organizations browsable. An app filter narrows recent people and suggested
**Office Champs**, while each group's full paid denominator and all seven app
totals stay intact.

Office Champs are suggestions, not assigned roles or volume rankings. Up to
three per group rank by positive app breadth, qualifying recency, normalized
display label and exact identity, over the complete matching population.

Use **Office observation** for Latest current details or a weekly summary, and
**Office baseline** for an earlier capture. Weekly summaries offer
**Explore current people**, because historical person records are not archived.
Current person details show frozen facts for that observation; opening a separate
current profile cannot replace them.

Office navigation uses `adoption=office`, `officeSnapshot` and `officeBaseline`.
Agent report `snapshot`/`baseline` choices remain independent. Bookmarks,
Back/Forward and links from Dashboard preserve the selected Office context.
Removed or replaced observations recover explicitly; failures do not silently
combine panels from different observations.

### Agent adoption

**Users > Adoption > Agents** groups saved paid users and positively used report
agents by company/department, five groups per page. Report-only agents remain
visible without an inventory link. A shared agent can appear in several groups
but counts once in the overall **Agents used** measure.

Up to three **Agent Champs** per group rank by reported responses, distinct
positively used agents, lowercase name and exact identity. Positive responses
or positively used agents qualify; creating an unused agent does not.

## Agent responsibility in user details

The **Responsibility** tab shows saved **Owner**, **Created by** and
**Last modified by** relationships with observation dates and paged agent rows.
Modification is not proof of ownership or ongoing responsibility. None of these
relationships grants access or management permission.

Responsibility can be available for people outside both user cohorts. Missing
profile, license or usage evidence does not hide an exact saved relationship.
Browsing makes no provider call and never guesses a person from a display name.

## Troubleshooting small or unexpected counts

| Symptom | Check |
| --- | --- |
| Checked directory candidates exceed licensed users | Expected when discovered products include disabled, inactive or unverified paid features. Compare effective entitlement, not assignment/headcount. |
| License count is unknown | Check the directory source outcome in Sync and configured application credentials/consent in Permissions. Do not assign the signed-in person a Microsoft reader role to fix application collection. |
| HTTP 400 from directory collection | Investigate the Graph query/schema diagnostic, not extra consent. Incomplete evidence must not become zero. |
| Licensed users appear but Office activity is unavailable | The sources are independent. Resolve report collection separately; do not reassign licenses to repair access. |
| Active report users are missing from the non-paid view | Check completed identity verification, privacy settings and unique exact identity matching. Unknown is not unpaid. |
| Department/company is missing | Check the directory fields. Display names or inventory owners do not supply organization membership. |
| A report download fails | Retry collection to obtain a fresh signed download; check outbound HTTPS to Graph and the supported report-download hosts. |
| Microsoft sign-in says access is unavailable | Review Conditional Access with the tenant administrator and an approved account/device/network; it is not a license-count problem. |

Collection streams records, follows validated continuation links and checks
provider counts, duplicate identities, schema, deadlines and storage bounds.
Oversized individual records or unavailable source evidence fail explicitly
without replacing the last complete source. See the
[current resource boundaries](data-architecture.md#collection-and-publication).

Use normalized source diagnostics such as `provider_count_mismatch`,
`provider_schema`, `provider_result_limit` or `data_generation_bytes` in authorized
operational logs. Never extract session tokens or signed download URLs for
troubleshooting. For API/storage details, see
[saved-data architecture](data-architecture.md#official-reports-and-user-evidence);
for operational recovery, see [sync diagnostics](operations.md#diagnose-synchronization-problems).
