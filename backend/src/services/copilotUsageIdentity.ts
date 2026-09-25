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
  const matching = matchCopilotIdentities(directoryAvailable ? directoryUsers : [], imported, summary => summary.username);
  const unresolved: CopilotUsageUnresolvedImportedIdentity[] = matching.unresolved.map(value => ({
    normalizedUserPrincipalName: value.normalizedIdentity,
    importedUsage: value.value,
    reason: directoryAvailable ? value.reason : "directory_unavailable",
  }));
  unresolved.sort((left, right) => left.normalizedUserPrincipalName.localeCompare(right.normalizedUserPrincipalName));
  return { byObjectId: matching.byObjectId, unresolved };
}

export function matchCopilotIdentities<T>(
  directoryUsers: readonly CopilotDirectoryUser[],
  records: readonly T[],
  identity: (value: T) => string,
) {
  const directoryKeys = identityIndex(directoryUsers);
  const recordKeys = new Map<string, T[]>();
  for (const record of records) {
    const key = normalizeCopilotIdentity(identity(record));
    const rows = recordKeys.get(key) ?? [];
    rows.push(record);
    recordKeys.set(key, rows);
  }

  // Count every possible row before rejecting ambiguous keys; another alias must not bypass them.
  const candidateCounts = new Map<string, number>();
  for (const [key, rows] of recordKeys) {
    for (const user of directoryKeys.get(key) ?? []) {
      const objectId = user.identity.objectId;
      candidateCounts.set(objectId, (candidateCounts.get(objectId) ?? 0) + rows.length);
    }
  }
  const byObjectId = new Map<string, T>();
  const unresolved: Array<{
    normalizedIdentity: string;
    value: T;
    reason: "no_exact_directory_match" | "ambiguous_directory_match";
  }> = [];
  for (const [key, rows] of recordKeys) {
    const directoryMatches = directoryKeys.get(key) ?? [];
    const objectId = directoryMatches.length === 1 ? directoryMatches[0].identity.objectId : undefined;
    if (objectId !== undefined && candidateCounts.get(objectId) === 1) {
      byObjectId.set(objectId, rows[0]);
      continue;
    }
    const reason = rows.length > 1 || directoryMatches.length > 0
      ? "ambiguous_directory_match" as const
      : "no_exact_directory_match" as const;
    for (const value of rows) {
      unresolved.push({ normalizedIdentity: key, value, reason });
    }
  }
  return { byObjectId, unresolved };
}

function identityIndex(users: readonly CopilotDirectoryUser[]) {
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
