# Official usage import

This runbook imports the Microsoft 365 admin-center Copilot Agents usage exports. These files are the only official per-agent and per-user usage authority in Agent Control. Do not substitute audit, Defender, telemetry, transcripts, package events or Microsoft 365 Copilot app-adoption Graph reports.

## Export the three files

1. Sign in to the Microsoft 365 admin center with access to usage reports.
2. Open **Reports** (use **Show all** if Reports is hidden), then **Usage**. Under **Reports**, select **Microsoft Copilot > Agents**.
3. Select one documented reporting window: 7 days or 30 days.
4. Select each **Agents**, **Users & agents**, and **Users** table/tab and use its **Export CSV** action for that same period.
5. Keep the original files until Agent Control confirms that the complete bundle is active.

Microsoft says interaction usage can become visible within one hour. That is source latency, not proof that an exported or imported set is current. Record the reporting start/end shown by the report. Enter a source as-of timestamp only when the Microsoft report explicitly shows one.

Microsoft source: [Copilot Agents usage report](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide), rechecked 2026-09-09; source page updated 2026-08-18.

## Supported schemas

Header matching is case/whitespace normalized but otherwise exact. These labels are both current Microsoft documentation and fixture-observed export evidence:

| Export | Schema | Required headers |
| --- | --- | --- |
| Agents | `m365-agents-observed-v1` | Agent ID; Agent name; Creator type; Active users (licensed); Active users (unlicensed); Responses sent to users; Last activity date (UTC) |
| Users & agents | `m365-users-agents-observed-v1` | Agent ID; Agent name; Creator type; Username; Responses sent to users; Last activity date (UTC) |
| Users | `m365-users-observed-v1` | Username; Display name; Number of agents used; Agent responses received; Last activity date (UTC) |

The CSVs do not contain reporting-period or source-as-of metadata columns. Agent Control therefore labels supplied values `operator_asserted` and source freshness `unknown`. Download time is retained separately. It is never used to infer period compatibility.

Microsoft documents the following interpretation constraints:

- **Active users (licensed)** and **Active users (unlicensed)** are independent source categories. A license change can place one person in both categories during the selected period, so even one agent's distinct total can be less than their sum. Agent Control never adds them. Per-agent distinct active users come from exact Users & agents identities; without that bridge the value is `Unknown`.
- Response values from Agents, Users & agents, and Users remain separate source totals. The headline response total uses Agents only and excludes bridge-only agents instead of creating a hybrid total.
- In Users & agents, **Last activity date (UTC)** is when that agent was last used by anyone. It is preserved with that exact meaning and is not used as the named user's recency. User recency comes from the Users export and is `Unknown` when no Users row exists.
- Usernames can be anonymized according to Microsoft 365 report settings. They remain case-sensitive dataset-scoped identifiers and are never guessed back to people.

## Validate and accept

1. Sign in with `AgentControl.Administrator`; this role does not grant aggregate or user-content read access.
2. Open **Official usage** and use its Administrator-only import panel to enter the report start/end dates. Select **This bundle is an explicit correction** before replacing an active set.
3. Choose one or more original CSVs and select **Validate and stage**. The server, not the browser, identifies each kind and parses the rows.
4. Review the full bundle hash, coverage, per-file hash/schema/period/source basis, warnings and reconciliation. Source values that disagree remain separate and visible.
5. Add missing companions to the same bundle. Reloading restores the current administrator's active staging. Incomplete submissions remain non-published and cannot change active usage.
6. Select **Accept reviewed bundle** only when all three kinds are present. The server rechecks the bundle hash and active-selection revision and commits all staged companions atomically.

Exact retries use a finite content-free receipt containing tenant, actor, bundle, original hash/revision and original result. They return that result after staging cleanup without replaying or reselecting anything; changed intent fails. A correction creates a superseding set. Selecting or deleting a retained set requires a separate native confirmation dialog. Deleting the active set clears selection; Agent Control never chooses an older set automatically.

## Limits and retention

| Boundary | Limit |
| --- | --- |
| File upload | 8 MiB, 50,000 rows, 4 KiB per field, valid UTF-8 |
| In-memory admission | Two concurrent uploads per application process; 15-second processing deadline |
| Actor staging | Nine retained rows, 150,000 parsed rows, 96 MiB; one kind per bundle intent |
| Tenant staging | 30 retained rows, 500,000 parsed rows, 256 MiB |
| Staging lifetime | 30 minutes; abandoned rows cleaned before admission, at startup and periodically |
| Atomic acceptance receipt | 180 days; content-free and independent of staging cleanup |
| Accepted content | 180 days, independent of staging |
| Minimal import audit | 90 days |
| Operation confirmations | 10 minutes; at most 20 live per actor |

Run ordinary [operator retention](operations.md#retention) at least daily while the POC is active. Load the existing internal helper and use its exact project/database confirmation, preview and bounded-batch safeguards as documented there. Retention is not a `deploy-local.ps1` argument.

`OFFICIAL_USAGE_STALE_AFTER_DAYS` defaults to 35 and accepts 1 through 365. A selected set is stale when either the report-period age or accepted-set age exceeds the threshold. Never treat `unknown` source freshness as current.

## Failure recovery

- A malformed, incompatible or schema-drift file is rejected without changing the active set. Correct the input and stage that kind again in the same bundle.
- A missing companion leaves the bundle incomplete and acceptance disabled. Reload or use **Resume** on the retained incomplete set.
- A stale bundle hash or active revision returns a conflict. Refresh import state and review the complete current bundle again.
- A partial discard failure remains visible. Refresh and retry only the staged rows still owned by the current administrator.
- Expired staging cannot be accepted. Re-export when freshness matters and stage the original files again.
- Upload timeout/disconnect cancels publication at the transaction boundary. If cleanup cannot be verified, the API returns `upload_cleanup_failed` when possible and emits only the value-free `official_usage_upload_cleanup_failed` operational event; inspect owned staging before retrying.
- If the legacy browser notice appears, its value was not read or migrated. Re-import the original files and acknowledge removal, or explicitly acknowledge discard. Only the exact legacy key is removed; unrelated browser storage remains.

## API availability review

The current Microsoft Graph [`copilotReportRoot`](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/resources/copilotreportroot) lists exactly three `v1.0`/`beta` methods: `getMicrosoft365CopilotUserCountSummary`, `getMicrosoft365CopilotUserCountTrend`, and `getMicrosoft365CopilotUsageUserDetail`. They cover licensed Microsoft 365 Copilot app adoption/activity, not the Copilot Agents report's per-agent rows, user-agent bridge, licensed/unlicensed active-user categories and responses. Agent Control does not request `Reports.Read.All` or automate these methods for this feature.