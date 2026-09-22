import type { CopilotDirectoryUser, CopilotUsageUnresolvedImportedIdentity } from "../types/copilotUsage.js";
import type { OfficialUsageUserSummary } from "../types/officialUsage.js";

export function normalizeCopilotIdentity(value: string) {
  return value.trim().toLowerCase();
}

export function hasReportedAgentActivity(user: OfficialUsageUserSummary): boolean {
  return (!user.missingUserReport && user.reportedResponsesReceived > 0)
    || user.rows.some(row => row.responsesSentToUsers > 0);
}

export function matchImportedUsage(
  directoryUsers: readonly CopilotDirectoryUser[],
  imported: readonly OfficialUsageUserSummary[],
  directoryAvailable: boolean,
) {
  const directoryKeys = identityIndex(directoryUsers);
  const importedKeys = new Map<string, OfficialUsageUserSummary[]>();
  for (const summary of imported) {
    const key = normalizeCopilotIdentity(summary.username);
    const rows = importedKeys.get(key) ?? [];
    rows.push(summary);
    importedKeys.set(key, rows);
  }
  const byObjectId = new Map<string, OfficialUsageUserSummary>();
  const unresolved: CopilotUsageUnresolvedImportedIdentity[] = [];
  const candidates = new Map<string, Array<{ key: string; summary: OfficialUsageUserSummary }>>();
  for (const [key, summaries] of importedKeys) {
    const directoryMatches = directoryKeys.get(key) ?? [];
    if (directoryAvailable && summaries.length === 1 && directoryMatches.length === 1) {
      const objectId = directoryMatches[0].identity.objectId;
      const values = candidates.get(objectId) ?? [];
      values.push({ key, summary: summaries[0] });
      candidates.set(objectId, values);
      continue;
    }
    const reason = !directoryAvailable
      ? "directory_unavailable" as const
      : summaries.length > 1 || directoryMatches.length > 1
        ? "ambiguous_directory_match" as const
        : "no_exact_directory_match" as const;
    for (const summary of summaries) {
      unresolved.push({ normalizedUserPrincipalName: key, importedUsage: summary, reason });
    }
  }
  for (const [objectId, values] of candidates) {
    if (values.length === 1) {
      byObjectId.set(objectId, values[0].summary);
    } else {
      unresolved.push(...values.map(value => ({
        normalizedUserPrincipalName: value.key,
        importedUsage: value.summary,
        reason: "ambiguous_directory_match" as const,
      })));
    }
  }
  unresolved.sort((left, right) => left.normalizedUserPrincipalName.localeCompare(right.normalizedUserPrincipalName));
  return { byObjectId, unresolved };
}

export function identityIndex(users: readonly CopilotDirectoryUser[]) {
  const result = new Map<string, CopilotDirectoryUser[]>();
  for (const user of users) {
    for (const key of new Set([
      normalizeCopilotIdentity(user.identity.userPrincipalName),
      normalizeCopilotIdentity(user.identity.objectId),
    ])) {
      const values = result.get(key) ?? [];
      values.push(user);
      result.set(key, values);
    }
  }
  return result;
}
