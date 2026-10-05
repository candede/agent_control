import type { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import type { SelectionIdentity } from "../src/services/dataSelections.js";

export async function officialReportFingerprint(reports: LargeTenantUsersReports, identity: SelectionIdentity) {
  const selected = await reports.capture(identity, "delegated", "official_agents");
  return reports.read(selected.id, identity, async (client, context) => {
    const agents = await reports.pageInRead(client, context, { limit: 1 });
    const users = await reports.rowsInRead(client, context, { endpoint: "official_users", limit: 1 });
    return {
      activeSetId: context.report.activeSetId, activeRevision: context.report.activeRevision,
      lineage: [...context.report.lineages].sort((left, right) => left.versionId.localeCompare(right.versionId)),
      aggregate: { responses: agents.summary.reportedResponses, activeUsers: agents.summary.distinctActiveReportUsers, reportAgents: agents.counts.total },
      users: { count: users.counts.total, responses: agents.summary.userReportedResponses,
        accessRows: context.report.lineages.find(row => row.kind === "userAgents")?.rowCount ?? 0 },
    };
  });
}
