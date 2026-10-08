# Provider requirements

This reference summarizes the Microsoft permissions and service requirements
used by Agent Control. Provider availability and authorization are verified when
an operation runs.

The [capability registry](../backend/src/services/capabilityRegistry.ts) is the
complete, current capability-ID and Microsoft source-reference inventory. The
table below summarizes its required permissions, not a dated readiness result.

| Feature | API and mode | Permission | Additional requirement |
| --- | --- | --- | --- |
| Package inventory | Microsoft Graph, delegated | `CopilotPackages.Read.All` | Microsoft Agent 365 license |
| Package inventory | Microsoft Graph, application | `CopilotPackages.Read.All` | Enabled application mode and approved tenant scope |
| Package access, block, unblock | Microsoft Graph, delegated | `CopilotPackages.ReadWrite.All` | Agent Control Admin and Microsoft Agent 365 license |
| User lookup | Microsoft Graph, delegated | `User.ReadBasic.All` | Entra member account |
| Group lookup | Microsoft Graph, delegated | `Group.Read.All` | Entra member account |
| User and license sync | Microsoft Graph, delegated | `User.Read.All`, `LicenseAssignment.Read.All` | Directory Readers or Global Reader |
| Copilot app activity | Microsoft Graph, delegated | `Reports.Read.All` | Reports Reader or AI Administrator |
| Agent identity resolution | Microsoft Graph, delegated | `AgentIdentity.Read.All` | Agent ID Administrator for nonowners |
| Power Platform inventory | Power Platform, delegated | `ResourceQuery.Resources.Read` | Supported Power Platform or AI role |
| Copilot Studio quarantine | Power Platform, delegated | `CopilotStudio.AdminActions.Invoke` | Agent Control Admin and supported administrator role |
| Purview Audit Search | Microsoft Graph, delegated | `AuditLogsQuery.Read.All` | Purview Audit role and Audit availability |
| Defender hunting | Microsoft Graph, delegated | `ThreatHunting.Read.All` | Security Reader or equivalent Defender RBAC |

## Permission checks

**Permissions > Check status** performs bounded readiness checks. It does not:

- import inventory;
- run audit or hunting jobs;
- make provider changes;
- grant consent;
- assign Microsoft roles;
- prove that a provider contains matching data.

The submitted operation reacquires authorization and the provider makes the
final access decision.

## Delegated and application access

Delegated access acts as the signed-in user and remains limited by that user's
roles, licenses, and service scope.

Application access must be enabled separately by an Agent Control Admin and
limited to an approved tenant-wide scope. It is not a fallback for failed
delegated access.

## Source boundaries

- Package inventory and Power Platform inventory are separate sources.
- Microsoft 365 Copilot app activity and imported Copilot Agents reports are
  separate sources.
- Purview and Defender evidence are investigation sources, not usage totals.
- Unknown and unavailable provider values remain unknown; they are not returned
  as successful empty data.

See [deployment setup](deployment-setup.md) and
[Microsoft roles](user-roles-and-permissions.md).
