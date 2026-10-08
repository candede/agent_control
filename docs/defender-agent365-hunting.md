# Defender and Agent 365 hunting

Agent Control runs explicit, curated Microsoft Graph advanced-hunting queries for
the selected agent. It does not expose arbitrary KQL or collect telemetry.

## Where to use it

Open **Agents > agent details > Activity**. The page keeps Defender runtime,
tool, and inventory evidence separate from saved Purview administration records.

Opening Activity does not run a hunt.

## Requirements

- Microsoft Graph delegated `ThreatHunting.Read.All`
- Tenant-wide admin consent
- Defender access to the queried data and device groups
- Entra **Security Reader**, or equivalent Defender Unified RBAC access
- `AgentControl.Viewer` or `AgentControl.Admin`

Resolving a Copilot Studio agent's Entra identity also requires delegated
`AgentIdentity.Read.All`. A user who does not own that identity needs
**Agent ID Administrator**.

See [Microsoft roles](user-roles-and-permissions.md).

## Data sources

| Source | Evidence |
| --- | --- |
| `AgentsInfo` | Agent inventory metadata, platform, model, publication state, and source identifiers |
| `CloudAppEvents` | Agent invocation, inference, tool-call, actor, error, and completion metadata when available |
| Purview Audit Search | Saved Copilot Studio administration records associated with the exact bot and environment |

Agent Control does not treat missing errors as proof of success and does not
reconstruct prompts, responses, or conversations.

## Resolve log identity

Defender sources use specific Entra object and application identifiers. Agent
Control verifies the identity before enabling a hunt.

1. Open the agent's **Activity** tab.
2. Review the saved inventory identity.
3. Select **Resolve log identity** when required.
4. Confirm the verified mapping before running a hunt.

Names, owners, package IDs, and shared blueprints are not used as identity
substitutes.

## Run a hunt

1. Select a supported log type.
2. Choose the bounded date range and available filters.
3. Review the exact selected agent and source identity.
4. Run the hunt.
5. Monitor the saved job and review paged results.

Queries use fixed templates and bounded result storage. Provider throttling,
partial pages, and source coverage are shown with the job.

## Authorization

Delegated hunts belong to the authorizing account. Optional application mode
requires separate application permission, Agent Control Admin enablement, and an
approved shared data scope.

**Permissions > Check status** verifies token readiness. It does not run a hunt
or prove that Defender has data for the selected agent.

## Jobs and retention

Hunt jobs support status, paging, minimized CSV export, cancellation, local
deletion, and recovery of accepted work. Closing the browser does not cancel an
accepted provider request.

Run the supported [retention workflow](operations.md#run-retention) to remove
expired saved jobs and results.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Hunting is unavailable | Confirm app role, Graph consent, Security Reader or Defender RBAC, and data scope. |
| Identity cannot be verified | Confirm current inventory, `AgentIdentity.Read.All`, consent, and Agent ID access. |
| No records are returned | Confirm the date range, selected template, telemetry ingestion, and exact agent mapping. |
| Results are partial | Review provider throttling, paging limits, and the saved job status. |

Microsoft references:

- [Advanced hunting overview](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-overview)
- [AgentsInfo table](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-agentsinfo-table)
- [Agent 365 observability attributes](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability-attribute-reference)
