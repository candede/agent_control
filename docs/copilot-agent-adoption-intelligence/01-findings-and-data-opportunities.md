# Findings and data opportunities

## Evidence context

These findings were observed during the November 7, 2026 (+04:00) read-only
investigation. They are not refreshed by opening this document.

- Latest saved agent-report set:
  `15dbf376-a947-49a4-b84c-d84cc39ccd8c`.
- Its observed activity range is **October 1-30, 2026**.
- Report-period provenance is `activity_range`; provider source-as-of metadata is
  absent. The observed range is not proof of a provider-declared complete
  calendar-month window.
- The saved Office observation uses a **November 4, 2026** provider refresh.
- Its D28 window is **October 8-November 4, 2026**, inclusive in UTC.

The Office and agent windows differ. Their combination identifies candidates for
follow-up, not proof that a person has never tried agents.

## Current findings

| Evidence | Observed finding | Adoption significance |
| --- | --- | --- |
| Saved directory population | **4,054 people**, 21 companies, 580 company/department groups | Supports local targeting, but the collected population is not complete enterprise headcount. |
| Paid Copilot entitlement | **2,267 people** | Provides a verified paid-user cohort. |
| Reported agent participation | **296 users**, including **200 paid users** | Only **8.8% of the saved paid cohort** has agent activity in the selected report. |
| Activity without active paid entitlement | **96 reported users** | Unknown or absent paid entitlement must not become a blanket assumption that agents cannot be used. |
| Office Copilot participation | **1,567 paid users**, or **69.1%** | Many colleagues already use Copilot in Office but have not crossed into agents. |
| Office-to-agent opportunity | **1,381 Office-active paid users have no agent activity in the selected report** | This is the strongest immediate activation pool, not proof of never having used an agent. |
| Office and agent overlap | **186 paid Office-active users** also have positive agent-report evidence | Distinguishes current observed overlap from the wider paid agent-user count of 200. |
| Reported agents | **304**: 281 user-created, 17 Microsoft, 6 third-party | Local agents are a major part of actual reported usage. |
| User-created activity | **10,070 of 11,552 responses, 87.2%** | Adoption should promote local workflows, not concentrate solely on Microsoft agents. |
| Microsoft-agent activity | **1,429 responses** | First-party agents remain an important reusable foundation. |
| Third-party-agent activity | **53 responses** | Keep third-party offerings distinct from Microsoft and local agents. |
| Authoring platform | **280 reported user-created agents** match Agent Builder packages; one user-created report agent lacks a current package match | Agent Builder is particularly important in this report. Do not infer an authoring platform from inventory-provider presence. |
| Logical inventory | **2,077 agents** | Inventory is much larger than reported usage; discovery, relevance, publication, and access deserve investigation. |

### Why the Office-to-agent opportunity matters

The main challenge is not necessarily to teach everyone Copilot from zero.
A large population already has Office familiarity. The next step can be
**task-specific agent discovery and peer-supported activation**.

For example:

- Excel familiarity can support introductions to dataset analysis or
  workbook-building agents.
- Word and PowerPoint familiarity can support management-reporting workflows.
- Outlook familiarity can support action-brief and communication workflows.

Office activity does not disclose the person's actual work task, preferences, or
proficiency. Recommendations should be candidates, not personal conclusions.

## Inventory and identity

The observed inventory represents:

- **1,377 Graph package records**.
- **1,661 Power Platform agent records**.
- **2,077 logical agents**, after canonical reconciliation.

These source counts must not be added as if they were unique logical agents.
Multiple packages and cross-provider memberships can represent the same agent.

There were **303 exact current package matches** for the 304 reported agents.
One report agent remained without that current package match. Missing linkage is
not proof of no use, deletion, or unavailability.

Display names are not identities. The saved data includes both Microsoft and
user-created agents named Analyst and multiple agents named Prompt Coach.
Recommendations must preserve exact report IDs, canonical IDs, publisher/origin
evidence, and source memberships.

Power Platform inventory includes Agent Builder agents. A record obtained from
Power Platform is not, by itself, proof that the agent was authored in Copilot
Studio. The selected report did not establish matched Studio-authored usage;
that is not proof of no Studio usage in other channels or outside its coverage.

## Metadata useful for generated knowledge

| Data | Observed availability | How to use it |
| --- | --- | --- |
| Graph About descriptions | **1,295 packages** have populated descriptions | Derive task fit, inputs, expected outputs, and candidate functional categories. |
| Native Power Platform descriptions | **Zero** populated descriptions across the 1,661 current agent records | Missing native descriptions must remain explicit; use another permitted, exactly linked source when available. |
| Provider categories | Missing from the shared user-created package population | AI-derived task categories must be labelled separately from provider categories. |
| Used/created/owned/modified relationships | Available as distinct saved facts | Find local users and makers without equating ownership or creation with expertise or positive usage. |
| Publication, hosts, environments, and sharing/access evidence | Available with differing coverage and semantics | Help explain where an agent is offered and identify supported access questions. |
| Configuration metadata | Includes such fields as models, authentication, orchestration, component counts, connector/flow counts, and instruction-character counts | These are metadata, not full instructions, knowledge contents, or proof of successful execution. |
| Provider telemetry | Saved package telemetry exists | Its reporting window and some units are not established; do not substitute it for official imported usage. |

About descriptions establish **declared capabilities**. They do not establish
successful task completion, calculation accuracy, business value, or effective
personal access.

## History and interpretation limits

- Three retained agent-report sets support snapshot comparisons.
- The latest and preceding report ranges overlap. They cannot be added or
  subtracted to manufacture exact interval activity.
- Office history currently contains only **one weekly aggregate point**.
- Historical Office points are aggregate-only. They cannot establish a person's
  historical usage habits.
- Current directory entitlement is not reconstructed historical licensing.
- Response counts are not a direct measure of productivity, expertise, quality,
  satisfaction, or ROI.
- A low-response agent can still serve an occasional valuable task.
- Missing reported activity is not proof that an employee never tried agents,
  abandoned them, or lacks interest.
- Office-app participation and the separately reported Word, Excel, and
  PowerPoint agents are different measures.

## Knowledge not established by the stored data

The investigation did not establish:

- Actual conversations or successful prompts used by employees.
- Completed business outcomes or time saved.
- Satisfaction, output quality, or reasons for non-use.
- An employee's exact business task or proficiency.
- A verified agent-use URL from the current discovery source contracts.
- Effective personal access merely from an agent being present, published, or
  administratively available.

These gaps explain why peer interviews and lightweight feedback are important.
They enrich learning and value claims; they are not prerequisites for normal
agent discovery or supported use.

## Contracts

- [Saved-data architecture](../data-architecture.md)
- [License, agent, and Office interpretation](../copilot-license-usage.md)
- [Official report interpretation](../official-usage-import.md)
- [MCP reference](../mcp-reference.md)
- [Current inventory authority](../../backend/src/db/inventoryAuthority.ts)
