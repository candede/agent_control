# Microsoft 365 Copilot licenses and usage

Use **Users** to check paid Copilot access and reported agent use. Use
**Dashboard > Copilot in Office apps** or **Users > Adoption > Office apps**
to review Copilot adoption in Word, Excel, PowerPoint, Outlook, OneNote, Loop
and Teams.

Agent usage and Office activity are separate:

| Data | Source |
| --- | --- |
| Paid Copilot access, company and department | Automatically collected Microsoft Graph directory/license data |
| Office-app activity | Automatically collected per-user **D28/v2** Microsoft report |
| Agent responses, agents used and agent last activity | Imported **Agents**, **Users & agents** and **Users** CSVs |

## Before you start

- Have `AgentControl.Viewer`, `AgentControl.UsageReportUploader` or
  `AgentControl.Admin` access. All three can read shared saved data and run
  read-only sync.
- For automatic collection, configure the Agent Control application's credentials
  and these Microsoft Graph **Application** permissions with **Grant admin consent**:

  | Data | Permissions |
  | --- | --- |
  | Directory and licenses | `User.Read.All`, `LicenseAssignment.Read.All` |
  | Office activity | `Reports.Read.All` |

  The signed-in reader needs no Microsoft directory or reporting role; an
  administrator does not need to remain signed in.
- For agent activity, have an Uploader or Admin
  [import the three CSVs for the same reporting period](official-usage-import.md).
  Downloading them from Microsoft 365 separately requires **Reports Reader** or
  **AI Administrator** on the exporting account.

See [roles and permissions](user-roles-and-permissions.md) for assignments.
Concealed, unmatched or ambiguous report identities cannot establish a person's
license or activity match; they remain unknown.

## How data refreshes

Read-only collection starts automatically after sign-in while the app is visible
and online, including after installation or a database reset. No manual start or
Permissions check is required. Collection is due every six hours; failed automatic
attempts normally wait an hour, subject to provider backoff.

Open **Sync** for progress, errors or an explicit refresh. Directory/license and
Office sources collect independently; failures preserve the last successful data.
Office collection does not require agent CSVs or inventory.

Saved data is tenant-shared. Viewing, filtering and exporting do not call Microsoft
Graph. A changed usable default agent report automatically makes directory
verification due; newly reported identities remain license-unknown until it succeeds.

## 1. Review users

Open **Users**, keep the **Users** view selected and choose **User cohort**:

| Cohort | Included people |
| --- | --- |
| **Paid M365 Copilot users** | Saved users with at least one verified usable paid feature, including grace-period and partially active users, even without reported usage |
| **Active users without paid Copilot** | Uniquely matched, currently verified non-paid users with positive reported agent responses |

Unknown licensing is not unpaid licensing. Coverage notices explain excluded
identities. Neither cohort measures basic/free Copilot Chat use.

1. Choose a **Report set** for agent activity.
2. Search or use **Filters** for company, department, activity, low-response
   threshold and sort order. Select a summary card to filter the paid-user table.
3. Select a person for **Overview**, **Usage & agents**, **Licenses** or
   **Responsibility**.
4. Select **Export users CSV** to download all matching people, not just the page.

Filters and exports cover the complete saved cohort. Missing company/department
values appear as **Not set**. Paid-user summary cards stay organization-wide within
the selected report/source context; table filters do not change them. The
low-response threshold affects **Needs attention**.

| Summary card | Meaning |
| --- | --- |
| **Active M365 Copilot licensed users** | Usable paid access, not recent use or account sign-in activity |
| **Using agents** | Positive response evidence in the selected agent reports |
| **Needs attention** | No/low reported agent usage, qualifying inactive-app evidence, or grace-period/partially active paid features; a review list, not a license-removal instruction |
| **No reported agent activity** | Available reports support absence of reported agent activity |

Missing reports, uncertain matches and missing metrics mean unknown, not zero.
Response totals, agents used and user last activity come from **Users**.
**Users & agents** relationship totals stay separate: positive relationships can
establish activity but cannot fill missing user totals. Zero-response relationships
remain visible without counting as positively used agents.

**Usage & agents** also shows Office-app dates. **Responsibility** shows saved
Owner, Created by and Last modified by relationships, even without license/usage
details. Modification does not prove ownership; relationships grant no permissions.

Export is unavailable with unresolved filters/reads or unavailable non-paid
verification. Report-user exports include all relationships of matching people,
even outside the selecting filter. Repeated user totals must not be added.

### License status

A product assignment alone does not prove paid access. Classification checks
current assignments, disabled plans and effective paid-feature evidence.

| Evidence | Meaning |
| --- | --- |
| **Active** | Enabled paid feature |
| **Active (grace period)** | Usable paid feature in warning state |
| **Partially active** | At least one usable paid feature mixed with inactive or unverified features; counts once as paid |
| Disabled, suspended, locked out or deleted features | Not active paid access unless another paid feature is usable |
| **License not verified** | Missing or conflicting evidence; not proof of being unlicensed |
| Verified identity with no assigned paid service | No active M365 Copilot license |

A feature disabled in one product can be enabled by another. Account sign-in
status is separate. Checked directory candidates are not headcount or paid-user totals.

### Agent adoption by group

Open **Users > Adoption > Agents** for company/department groups. Report-only
agents need no inventory link; shared agents count once overall. Up to three
**Agent Champs** per group are suggested by responses and positively used agents,
not by creating an unused agent.

## 2. Review Office adoption

1. Open **Dashboard > Copilot in Office apps**. Review participation, app adoption
   and department gaps. Company selection narrows the department panel, not the
   organization cards or trends.
2. Select **Explore Office groups**, or open **Users > Adoption > Office apps**.
   Search company/department groups, apply filters and page through groups or
   people. Select a person for the captured Office details.
3. Use **Office observation** for Latest details or a weekly summary, and
   **Office baseline** for an earlier comparison. Weekly summaries have no
   person records; use **Explore current people** for current saved details.

App filters narrow recent people and **Office Champs**, not the group's paid
denominator or seven app totals. Up to three Champs per group are suggested by
app breadth and recency, not volume or an assigned role.

### What Office metrics mean

| Measure | Meaning |
| --- | --- |
| **Enabled paid Copilot users** | Exact saved identities with usable paid features at capture; not tenant headcount |
| **Active Office users** | Distinct saved licensed people with qualifying recent activity in at least one of the seven apps |
| Participation | Active Office users divided by enabled paid Copilot users |
| **No recent Office activity reported** | No qualifying app date in the window; not proof of inactivity or unused licenses |
| Unknown evidence | A subset of people without recent evidence, not an additional inactive population |

Recent means the provider refresh date minus 27 days through that date, inclusive
in UTC—not the upload date or today. Older app dates remain visible. Missing or
invalid source inputs mean unavailable, not zero.

App counts overlap: one person using three apps contributes three user-app pairs
but one active person. Copilot Chat, Edge, overall last activity and imported
agent activity do not count. These views measure no prompts, productivity or ROI.

Check **Activity report coverage**: incomplete coverage makes participation a
confirmed lower bound. Blank dates can reflect reporting delay or a new license.
Retained unseen rows keep original dates and remain unknown, not never-used.

### History and comparisons

History keeps one aggregate point per UTC Monday-start week for twelve calendar
months, using the latest D28/v2 report refreshed that week—not activity only
during that week. New reports/corrections replace that week's point.

Only the latest current observation has person-level details; weekly history
contains organization and group totals. Licenses and organization are frozen
at capture. Later changes or source aging do not rewrite measurements; current
freshness is shown separately. Stale app evidence does not establish current use
or an inactivity recommendation.

Graphs show weekly points in the last 30 calendar days through the selected
report and need two points. Switch between counts and share of enabled users.
The default baseline is about four weeks earlier when available; check its actual
date. Shorter history and denominator changes are disclosed. Rate changes are
percentage points.

## Report choices and bookmarks

The **Report set** choice on Users and Agents is personal. **Latest report** uses
the newest complete available reporting period, not upload date. Bookmarks preserve
a selection; Latest removes the pin. Older agent activity uses current saved
license evidence, not reconstructed historical licensing.

Office observations/baselines are independent of agent reports. Bookmarks and
Back/Forward preserve Office context. Removed/replaced choices recover with a
notice; permission or service failures do not silently select different data.

## Troubleshooting

| Problem | Check |
| --- | --- |
| No license data, or collection fails | Check the directory outcome in **Sync**, then application credentials/grants/consent in **Permissions**. Assigning the reader a Microsoft report role does not fix application collection. |
| Checked directory users exceed paid users | Compare effective paid features, not product assignments or tenant headcount. Disabled and unverified candidates can be included in the directory count. |
| Licenses appear but Office activity is unavailable | Check the Office source in **Sync**, `Reports.Read.All` consent and **Activity report coverage**, not license assignments. |
| People are missing from the non-paid cohort | Check directory verification, exact identity matching and report privacy settings. Concealed/ambiguous identities remain unknown. |
| Company or department is missing | Check the user's saved directory fields; display names and agent owners do not supply organization membership. |
| Report download fails | Retry collection for a fresh download. Check outbound HTTPS to Graph and supported report-download hosts. |
| HTTP 400 during directory collection | Review the query/schema diagnostic, not extra consent. See [sync diagnostics](operations.md#diagnose-synchronization-problems). |
| Microsoft sign-in is blocked | Ask the tenant administrator to review Conditional Access for the account/device/network; this is not a license-count issue. |

For source definitions and recognized paid features, see
[saved-data architecture](data-architecture.md#official-reports-and-user-evidence).
