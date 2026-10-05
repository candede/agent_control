import { Readable } from "node:stream";
import { streamOfficialReport, type OfficialRow, type StreamedOfficialReport } from "../../backend/src/services/officialReportStream";
import type { OfficialUsageMetadata } from "../../backend/src/types/officialReportRecords";
import type { UserSourceMetadata } from "../../backend/src/types/userSources";
import type { ReportAgent, ReportMetadata, ReportObservation, ReportRelationship, ReportSummary, ReportUser } from "../../backend/src/types/officialReportData";
import { reportAgent, reportPage, reportUser } from "../src/test/reportDataFixture";

export type SelectedCsvFixture = StreamedOfficialReport & { rows: OfficialRow[] };
export async function parseSelectedCsv(bytes: Buffer, metadata?: OfficialUsageMetadata): Promise<SelectedCsvFixture> {
  const rows: OfficialRow[] = [];
  const report = await streamOfficialReport(Readable.from([bytes]), metadata, new AbortController().signal, {
    async batch(_kind, batch) {
      if (rows.length + batch.length > 250 || Buffer.byteLength(JSON.stringify([...rows, ...batch])) > 1024 * 1024) {
        throw new Error("The synthetic browser CSV fixture exceeds its 250-row/1-MiB bound");
      }
      rows.push(...batch);
    },
  });
  return { ...report, rows };
}

export function selectedImportMetadata(files: readonly SelectedCsvFixture[], context:
  Pick<ReportMetadata, "setId" | "activeSetId" | "activeRevision" | "historyRevision" | "historyEpoch" | "acceptedAt" | "expiresAt">): ReportMetadata {
  return { ...context, availability: context.setId ? "active" : "never_imported", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: context.setId ? 0 : null,
    reportingPeriod: files[0]?.reportingPeriod ?? null,
    lineages: files.map(file => ({ kind: file.kind, versionId: `${file.fileHash.slice(0, 8)}-${file.fileHash.slice(8, 12)}-4000-8000-${file.fileHash.slice(20, 32)}`,
      contentHash: file.fileHash, rowCount: file.rowCount, sourceAsOf: file.sourceAsOf ?? null, sourceAsOfProvenance: file.sourceAsOfProvenance,
      sourceFreshness: file.sourceFreshness, periodProvenance: file.reportingPeriod.provenance })) };
}

export function selectedImportData(files: readonly SelectedCsvFixture[], metadata: ReportMetadata) {
  const agentsFile = files.find(file => file.kind === "agents"), bridgeFile = files.find(file => file.kind === "userAgents");
  const usersFile = files.find(file => file.kind === "users");
  const rawAgents = agentsFile?.rows.filter(row => "activeUsersLicensed" in row) ?? [];
  const rawLinks = bridgeFile?.rows.filter(row => "agentId" in row && "username" in row) ?? [];
  const rawUsers = usersFile?.rows.filter(row => "agentResponsesReceived" in row) ?? [];
  const relationships: ReportRelationship[] = rawLinks.map((row, index) => ({
    id: `synthetic-relationship-${index}`, agentId: row.agentId, agentName: row.agentName, creatorType: row.creatorType,
    username: row.username, responses: row.responsesSentToUsers, lastActivityDateUtc: row.lastActivityDateUtc ?? null, identityStatus: "unresolved",
  }));
  const agentIds = [...new Set([...rawAgents.map(row => row.agentId), ...relationships.map(row => row.agentId)])];
  const agents: ReportAgent[] = agentIds.map((agentId, index) => {
    const source = rawAgents.find(row => row.agentId === agentId), links = relationships.filter(row => row.agentId === agentId);
    const bridge = links.length ? links.reduce((sum, row) => sum + row.responses, 0) : null;
    const dates = [source?.lastActivityDateUtc, ...links.map(row => row.lastActivityDateUtc)].filter((date): date is string => Boolean(date)).sort();
    return reportAgent(index, {
      agentId, agentName: source?.agentName ?? links[0]?.agentName ?? agentId, creatorType: source?.creatorType ?? links[0]?.creatorType ?? "",
      responses: source?.responsesSentToUsers ?? bridge ?? 0, responseSource: source ? "agents" : "userAgents",
      reportResponses: source?.responsesSentToUsers ?? null, bridgeResponses: bridge, relationshipCount: links.length,
      responseComparison: !source || bridge === null ? "not_comparable" : source.responsesSentToUsers === bridge ? "matching" : "mismatch",
      licensedUserOccurrences: source?.activeUsersLicensed ?? null, unlicensedUserOccurrences: source?.activeUsersUnlicensed ?? null,
      activeUsers: links.length ? new Set(links.filter(row => row.responses > 0).map(row => row.username)).size : null,
      activeUsersBasis: links.length ? "userAgents_distinct_identity" : "unknown",
      lastActivityDateUtc: source ? source.lastActivityDateUtc ?? null : dates.at(-1) ?? null,
    });
  });
  const usernames = [...new Set([...rawUsers.map(row => row.username), ...relationships.map(row => row.username)])];
  const users: ReportUser[] = usernames.map((username, index) => {
    const source = rawUsers.find(row => row.username === username), links = relationships.filter(row => row.username === username);
    const bridge = links.length ? links.reduce((sum, row) => sum + row.responses, 0) : null;
    const dates = [source?.lastActivityDateUtc, ...links.map(row => row.lastActivityDateUtc)].filter((date): date is string => Boolean(date)).sort();
    return reportUser(index, {
      username, displayName: source?.displayName ?? username, objectId: null, entitlement: "unknown", company: null, department: null,
      reportedResponses: source?.agentResponsesReceived ?? null, reportedAgentsUsed: source?.numberOfAgentsUsed ?? null,
      bridgeResponses: bridge, relationshipCount: links.length, responseProducingAgentCount: links.filter(row => row.responses > 0).length,
      userLastActivityDateUtc: source?.lastActivityDateUtc ?? null, lastActivityDateUtc: dates.at(-1) ?? null,
      hasActivity: (source?.agentResponsesReceived ?? 0) > 0 || (bridge ?? 0) > 0, missingUserReport: !source,
      hasReportMismatch: Boolean(source && bridge !== null && (source.agentResponsesReceived !== bridge || source.numberOfAgentsUsed !== links.length)),
      reviewCohort: !source ? "unknown" : source.agentResponsesReceived === 0 ? "zero" : source.agentResponsesReceived <= 5 ? "low" : "outside",
    });
  });
  const reportedResponses = agentsFile ? rawAgents.reduce((sum, row) => sum + row.responsesSentToUsers, 0) : null;
  const bridgeResponses = bridgeFile ? relationships.reduce((sum, row) => sum + row.responses, 0) : null;
  const userResponses = usersFile ? rawUsers.reduce((sum, row) => sum + row.agentResponsesReceived, 0) : null;
  const totals = [reportedResponses, bridgeResponses, userResponses].filter((value): value is number => value !== null);
  const summary: ReportSummary = {
    checkedUsers: 0, licensedUsers: null, measuredActivityUsers: null, needsAttentionUsers: null, usingAgentsUsers: null,
    noAgentActivityUsers: null, unknownMetricsUsers: null, unresolvedIdentities: usernames.length, activeWithoutPaidUsers: null,
    paidActiveReportUsers: null, unknownLicenseActiveReportUsers: users.filter(row => row.hasActivity).length,
    reportedResponses, bridgeResponses, userReportedResponses: userResponses,
    distinctActiveReportUsers: metadata.setId ? users.filter(row => row.hasActivity).length : null,
    licensedOccurrences: agentsFile ? rawAgents.reduce((sum, row) => sum + row.activeUsersLicensed, 0) : null,
    unlicensedOccurrences: agentsFile ? rawAgents.reduce((sum, row) => sum + row.activeUsersUnlicensed, 0) : null,
    responseReconciliation: totals.length < 2 ? "not_comparable" : Math.max(...totals) === Math.min(...totals) ? "matching" : "mismatch",
    activeUsersAreNonAdditive: true,
  };
  const observations: ReportObservation[] = metadata.lineages.map(lineage => ({
    versionId: lineage.versionId, kind: lineage.kind, contentHash: lineage.contentHash, rowCount: lineage.rowCount,
    acceptedAt: metadata.acceptedAt!, sourceAsOf: lineage.sourceAsOf, sourceAsOfProvenance: lineage.sourceAsOfProvenance,
    sourceFreshness: lineage.sourceFreshness, supersedesVersionId: null,
  }));
  const directory = reportPage([], { reports: metadata, summary, counts: { total: 0, filtered: 0 } });
  const unavailable = (value: UserSourceMetadata): UserSourceMetadata => ({
    ...value, state: "unavailable", generationId: null, observedAt: null, rowCount: 0, message: "Run Users sync to verify licensing.",
  });
  directory.sources = { directory: unavailable(directory.sources.directory), app_activity: unavailable(directory.sources.app_activity) };
  return { agents, users, relationships, summary, observations, directory };
}
